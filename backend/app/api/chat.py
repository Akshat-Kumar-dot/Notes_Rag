"""Chat over SSE.

Sources are emitted before the first token, so the UI renders citations while
the answer streams -- and if generation fails, the user still sees what was
retrieved. Retrieval succeeding and generation failing are different outcomes.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.auth.deps import DB, CurrentUser
from app.db import SessionLocal
from app.llm.gemini import LLMError, complete, stream
from app.models import Citation, Conversation, Folder, Message, Role
from app.rag import prompting
from app.rag.retrieval import retrieve
from app.schemas import ChatRequest, ConversationCreate, ConversationDetail, ConversationOut

log = logging.getLogger(__name__)
router = APIRouter(tags=["chat"])


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/conversations", response_model=ConversationOut,
             status_code=status.HTTP_201_CREATED)
async def create_conversation(payload: ConversationCreate, user: CurrentUser, db: DB):
    folders = list(
        await db.scalars(
            select(Folder).where(
                Folder.id.in_(payload.folder_ids), Folder.user_id == user.id
            )
        )
    )
    if len(folders) != len(set(payload.folder_ids)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "One of those folders wasn't found.")

    convo = Conversation(user_id=user.id, title=payload.title or "New chat")
    convo.folders = folders
    db.add(convo)
    await db.flush()
    return ConversationOut(
        id=convo.id, title=convo.title, created_at=convo.created_at,
        updated_at=convo.updated_at, folder_ids=[f.id for f in folders],
    )


@router.get("/conversations", response_model=list[ConversationOut])
async def list_conversations(user: CurrentUser, db: DB):
    rows = await db.scalars(
        select(Conversation)
        .where(Conversation.user_id == user.id)
        .options(selectinload(Conversation.folders))
        .order_by(Conversation.updated_at.desc())
        .limit(100)
    )
    return [
        ConversationOut(
            id=c.id, title=c.title, created_at=c.created_at,
            updated_at=c.updated_at, folder_ids=[f.id for f in c.folders],
        )
        for c in rows
    ]


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(conversation_id: UUID, user: CurrentUser, db: DB):
    convo = await db.scalar(
        select(Conversation)
        .where(Conversation.id == conversation_id, Conversation.user_id == user.id)
        .options(
            selectinload(Conversation.folders),
            selectinload(Conversation.messages).selectinload(Message.citations),
        )
    )
    if convo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found.")
    return ConversationDetail(
        id=convo.id, title=convo.title, created_at=convo.created_at,
        updated_at=convo.updated_at, folder_ids=[f.id for f in convo.folders],
        messages=convo.messages,
    )


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: UUID, user: CurrentUser, db: DB):
    convo = await db.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id, Conversation.user_id == user.id
        )
    )
    if convo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found.")
    await db.delete(convo)


async def _generate(user_id: UUID, conversation_id: UUID, question: str) -> AsyncIterator[str]:
    # Own session: the request-scoped one closes as soon as streaming begins.
    async with SessionLocal() as db:
        try:
            convo = await db.scalar(
                select(Conversation)
                .where(Conversation.id == conversation_id, Conversation.user_id == user_id)
                .options(selectinload(Conversation.folders))
            )
            if convo is None:
                yield _sse("error", {"message": "Conversation not found."})
                return

            folder_ids = [f.id for f in convo.folders]
            history = [
                (m.role, m.content)
                for m in reversed(
                    list(
                        await db.scalars(
                            select(Message)
                            .where(Message.conversation_id == convo.id)
                            .order_by(Message.created_at.desc())
                            .limit(6)
                        )
                    )
                )
            ]

            db.add(Message(conversation_id=convo.id, role=Role.USER, content=question))
            await db.commit()

            # "What about the second one?" is useless as a search query verbatim.
            search_query = question
            if history:
                try:
                    rewritten = await complete(prompting.build_rewrite(question, history))
                    if rewritten:
                        search_query = rewritten[:400]
                except LLMError:
                    pass  # rewriting is an optimisation, not a requirement

            result = await retrieve(
                db, user_id=user_id, folder_ids=folder_ids, query=search_query
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
                try:
                    async for token in stream(prompt):
                        buf.append(token)
                        yield _sse("token", {"delta": token})
                except LLMError as exc:
                    yield _sse("error", {"message": str(exc)})
                    return
                answer = "".join(buf)

            assistant = Message(
                conversation_id=convo.id,
                role=Role.ASSISTANT,
                content=answer,
                low_confidence=result.low_confidence,
                retrieval_ms=result.elapsed_ms,
            )
            db.add(assistant)
            await db.flush()

            for i, h in enumerate(result.hits, start=1):
                label = h.filename + (f", p.{h.page_number}" if h.page_number and h.page_number > 1 else "")
                db.add(
                    Citation(
                        message_id=assistant.id,
                        chunk_id=h.chunk_id,
                        rank=i,
                        score=h.score,
                        # Snapshot, so history survives the source being deleted.
                        excerpt_snapshot=h.text[:700],
                        source_label=label[:400],
                    )
                )

            # First exchange in a fresh conversation: title it from the question.
            # `history` was loaded before this turn's message was added, so it is
            # empty exactly when this is the first turn. Avoid touching
            # convo.messages -- that lazy relationship isn't loaded here, and
            # accessing it under async SQLAlchemy raises MissingGreenlet.
            if not history and convo.title == "New chat":
                convo.title = question[:80]
            await db.commit()

            yield _sse("done", {"message_id": str(assistant.id)})

        except Exception:
            log.exception("chat stream failed")
            await db.rollback()
            yield _sse("error", {"message": "Something went wrong generating that answer."})


@router.post("/conversations/{conversation_id}/messages")
async def send_message(
    conversation_id: UUID, payload: ChatRequest, user: CurrentUser
) -> StreamingResponse:
    return StreamingResponse(
        _generate(user.id, conversation_id, payload.message),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # stop proxies buffering the stream
            "Connection": "keep-alive",
        },
    )
