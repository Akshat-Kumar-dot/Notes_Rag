"""Chat over SSE.

Sources are emitted before the first token, so the UI renders citations while
the answer streams -- and if generation fails, the user still sees what was
retrieved. Retrieval succeeding and generation failing are different outcomes.

Conversations live in MongoDB (app.chat_store). Postgres is still used here to
validate folder ownership and to run retrieval over the chunks.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import defaultdict
from collections.abc import AsyncIterator
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app import chat_store
from app.auth import guest
from app.auth.deps import DB, CurrentUser
from app.config import settings
from app.db import SessionLocal
from app.llm.gemini import LLMBusy, LLMError, complete, stream
from app.models import Folder
from app.rag import prompting
from app.rag.retrieval import retrieve
from app.schemas import (
    ChatGraph, ChatRequest, ConversationCreate, ConversationDetail, ConversationOut, GraphEdge,
    GraphNode,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["chat"])


# Retries when the model is busy (429/503), before the first token only.
# Short on purpose: the reader is watching a spinner the whole time.
RETRY_DELAYS_S = (2, 5)
# The rewrite is an optimisation. Under load, skip it rather than wait.
REWRITE_TIMEOUT_S = 8.0


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/conversations", response_model=ConversationOut,
             status_code=status.HTTP_201_CREATED)
async def create_conversation(payload: ConversationCreate, user: CurrentUser, db: DB):
    # Folders are still Postgres rows: check the user owns every one of them.
    folder_ids = list(
        await db.scalars(
            select(Folder.id).where(
                Folder.id.in_(payload.folder_ids), Folder.user_id == user.id
            )
        )
    )
    if len(folder_ids) != len(set(payload.folder_ids)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "One of those folders wasn't found.")

    # A conversation is useless to a guest without a question to spend in it,
    # and without a cap a script could fill MongoDB with empty ones.
    if user.is_guest and await chat_store.count_conversations(user.id) >= settings.guest_messages:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You've used your free questions. Sign in with Google to keep asking.",
        )

    convo = await chat_store.create_conversation(user.id, folder_ids, payload.title)
    return ConversationOut(**convo)


@router.get("/conversations", response_model=list[ConversationOut])
async def list_conversations(user: CurrentUser):
    return [ConversationOut(**c) for c in await chat_store.list_conversations(user.id)]


# ---- chat graph ------------------------------------------------------------
# Two chats are linked when their answers drew on the same passages of the
# user's notes -- data every answer already stores, so the graph costs no model
# calls, and every link can say why it exists. Same file, different passages,
# is a weaker link. Each chat keeps only its strongest few links, or a busy
# folder turns into a hairball.
GRAPH_LINKS_PER_CHAT = 5
SAME_FILE_WEIGHT = 0.25
_PAGE_SUFFIX = re.compile(r", p\.\d+$")


def _file_name(label: str) -> str:
    """Citation labels are 'name.pdf, p.4'; the file is the part before."""
    return _PAGE_SUFFIX.sub("", label or "").strip() or "a file"


# Declared before /conversations/{conversation_id}: routes match in order, and
# "graph" would otherwise be parsed (and rejected) as a conversation id.
@router.get("/conversations/graph", response_model=ChatGraph)
async def chat_graph(user: CurrentUser) -> ChatGraph:
    rows = await chat_store.graph_rows(user.id)
    chunks: dict[UUID, set] = {}
    files: dict[UUID, dict] = {}
    by_file: dict = defaultdict(set)     # file id -> chats citing it
    nodes = []
    for d in rows:
        cid = d["_id"]
        cs, fs = set(), {}
        for m in d.get("messages", []):
            # A "your notes don't cover this" reply still lists its nearest
            # passages; they don't make two chats related.
            if m.get("low_confidence"):
                continue
            for c in m.get("citations", []):
                if c.get("chunk_id"):
                    cs.add(c["chunk_id"])
                if c.get("file_id"):
                    fs[c["file_id"]] = _file_name(c.get("source_label", ""))
        chunks[cid], files[cid] = cs, fs
        for f in fs:
            by_file[f].add(cid)
        nodes.append(GraphNode(
            id=cid, title=d.get("title") or chat_store.NEW_CHAT_TITLE,
            folder_ids=d.get("folder_ids", []), message_count=d.get("message_count", 0),
            updated_at=d["updated_at"], passages=len(cs),
        ))

    # Only chats that share at least one file can be linked, so compare those
    # pairs instead of every pair.
    pairs = set()
    for members in by_file.values():
        ms = sorted(members, key=str)
        pairs.update((a, b) for i, a in enumerate(ms) for b in ms[i + 1:])

    candidates: dict = defaultdict(list)
    for a, b in pairs:
        shared = chunks[a] & chunks[b]
        shared_files = files[a].keys() & files[b].keys()
        weight = len(shared) + SAME_FILE_WEIGHT * len(shared_files)
        edge = GraphEdge(source=a, target=b, weight=round(weight, 2), passages=len(shared),
                         files=sorted({files[a][f] for f in shared_files})[:3])
        candidates[a].append(edge)
        candidates[b].append(edge)

    keep: dict = {}
    for edges in candidates.values():
        for e in sorted(edges, key=lambda e: -e.weight)[:GRAPH_LINKS_PER_CHAT]:
            keep[(e.source, e.target)] = e
    return ChatGraph(nodes=nodes, edges=list(keep.values()))


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(conversation_id: UUID, user: CurrentUser):
    convo = await chat_store.get_conversation(conversation_id, user.id)
    if convo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found.")
    return ConversationDetail(**convo)


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: UUID, user: CurrentUser):
    if not await chat_store.delete_conversation(conversation_id, user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found.")


async def _generate(
    user_id: UUID, conversation_id: UUID, question: str, *, guest_credit: bool = False
) -> AsyncIterator[str]:
    async def failed() -> None:
        # A guest paid a credit up front; don't keep it when the answer failed
        # for reasons that were not theirs.
        if guest_credit:
            await guest.refund(user_id, "message")

    try:
        convo = await chat_store.load_for_turn(conversation_id, user_id, history_n=6)
        if convo is None:
            await failed()
            yield _sse("error", {"message": "Conversation not found."})
            return

        # Loaded before this turn's message is added, so it is empty exactly
        # when this is the first turn.
        history = [(m["role"], m["content"]) for m in convo["messages"]]
        await chat_store.append_user_message(conversation_id, user_id, question)

        # "What about the second one?" is useless as a search query verbatim.
        search_query = question
        if history:
            try:
                rewritten = await complete(
                    prompting.build_rewrite(question, history), timeout=REWRITE_TIMEOUT_S
                )
                if rewritten:
                    search_query = rewritten[:400]
            except LLMError:
                pass  # rewriting is an optimisation, not a requirement

        # Own session: the request-scoped one closes as soon as streaming begins.
        async with SessionLocal() as db:
            result = await retrieve(
                db, user_id=user_id, folder_ids=convo["folder_ids"], query=search_query
            )

        yield _sse(
            "sources",
            {
                "query": search_query,
                "low_confidence": result.low_confidence,
                "retrieval_ms": result.elapsed_ms,
                "chunks": [
                    {
                        "n": i,
                        "chunk_id": str(h.chunk_id),
                        "file_id": str(h.file_id),
                        "filename": h.filename,
                        "folder_name": h.folder_name,
                        "page_number": h.page_number,
                        "heading": h.heading,
                        "excerpt": h.text[:700],
                        "score": round(h.score, 4),
                    }
                    for i, h in enumerate(result.hits, start=1)
                ],
            },
        )

        if not result.hits:
            answer = (
                "I couldn't find anything about that in this folder. "
                "Try different wording, or check the file finished indexing."
            )
            yield _sse("token", {"delta": answer})
        else:
            prompt = prompting.build_prompt(question, result.hits, history)
            buf: list[str] = []
            for attempt in range(len(RETRY_DELAYS_S) + 1):
                try:
                    async for token in stream(prompt):
                        buf.append(token)
                        yield _sse("token", {"delta": token})
                    break
                except LLMBusy as exc:
                    # Never after the first token: a retry would repeat text
                    # the reader has already seen.
                    if buf or attempt == len(RETRY_DELAYS_S):
                        await failed()
                        yield _sse("error", {"message": str(exc)})
                        return
                    # The UI shows a "reconnecting" state while this waits.
                    yield _sse("status", {"state": "reconnecting", "attempt": attempt + 1})
                    await asyncio.sleep(RETRY_DELAYS_S[attempt])
                except LLMError as exc:
                    await failed()
                    yield _sse("error", {"message": str(exc)})
                    return
            answer = "".join(buf)

        citations = []
        for i, h in enumerate(result.hits, start=1):
            label = h.filename + (f", p.{h.page_number}" if h.page_number and h.page_number > 1 else "")
            citations.append(
                {
                    "rank": i,
                    "score": h.score,
                    "chunk_id": h.chunk_id,
                    # file_id / folder_id stand in for the old foreign key, so
                    # detach_file / detach_folder can find these citations.
                    "file_id": h.file_id,
                    "folder_id": h.folder_id,
                    # Snapshot, so history survives the source being deleted.
                    "excerpt_snapshot": h.text[:700],
                    "source_label": label[:400],
                }
            )

        # First exchange in a fresh conversation: title it from the question.
        title = question[:80] if not history and convo["title"] == chat_store.NEW_CHAT_TITLE else None

        message_id = await chat_store.append_assistant_message(
            conversation_id,
            user_id,
            content=answer,
            low_confidence=result.low_confidence,
            retrieval_ms=result.elapsed_ms,
            citations=citations,
            title=title,
        )
        yield _sse("done", {"message_id": str(message_id)})

    except Exception:
        log.exception("chat stream failed")
        await failed()
        yield _sse("error", {"message": "Something went wrong generating that answer."})


@router.post("/conversations/{conversation_id}/messages")
async def send_message(
    conversation_id: UUID, payload: ChatRequest, user: CurrentUser, db: DB
) -> StreamingResponse:
    # Spent before streaming starts, so an exhausted guest gets a plain 403
    # instead of a stream. Committed here: the request session's own commit
    # is not guaranteed to run before the stream does.
    await guest.spend(db, user, "message")
    await db.commit()
    return StreamingResponse(
        _generate(user.id, conversation_id, payload.message, guest_credit=user.is_guest),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # stop proxies buffering the stream
            "Connection": "keep-alive",
        },
    )
