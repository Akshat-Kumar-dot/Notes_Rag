"""One-off migration: Postgres chat history -> MongoDB (step 5 of MONGODB_MIGRATION.md).

Run from backend/ with the venv active:

    python migrate_chat_to_mongo.py --dry-run    # read + build, write nothing
    python migrate_chat_to_mongo.py              # write, then verify

Reads DATABASE_URL / MONGODB_URL the same way the app does (.env, overridable
by real env vars), so the production run in step 7 needs no code change.

Idempotent: every conversation is written with replace_one(upsert=True) on its
original Postgres UUID, so a rerun overwrites with identical data instead of
duplicating. Postgres is only read, never modified.
"""
from __future__ import annotations

import argparse
import asyncio
import uuid
from collections import defaultdict
from pprint import pprint
from typing import Any

from pymongo import ReplaceOne
from sqlalchemy import select

from app import mongo
from app.db import SessionLocal, engine
from app.models import Chunk, Citation, Conversation, Message, conversation_folders

BATCH = 200


async def read_postgres() -> tuple[list, list, list, list]:
    """Four bulk reads instead of one query per conversation (N+1). The whole
    chat history fits in memory -- Neon's free tier caps it well below that."""
    async with SessionLocal() as db:
        convos = (await db.execute(
            select(Conversation.id, Conversation.user_id, Conversation.title,
                   Conversation.created_at, Conversation.updated_at)
        )).all()
        links = (await db.execute(
            select(conversation_folders.c.conversation_id, conversation_folders.c.folder_id)
        )).all()
        messages = (await db.execute(
            select(Message.id, Message.conversation_id, Message.role, Message.content,
                   Message.created_at, Message.low_confidence, Message.retrieval_ms)
        )).all()
        # Postgres citations never stored file_id/folder_id -- the foreign key
        # to chunks implied them. Recover them with the join. A LEFT join, so
        # citations whose source was deleted (chunk_id NULL) come back with
        # file_id/folder_id NULL rather than disappearing.
        citations = (await db.execute(
            select(Citation.message_id, Citation.rank, Citation.score, Citation.chunk_id,
                   Chunk.file_id, Chunk.folder_id,
                   Citation.excerpt_snapshot, Citation.source_label)
            .outerjoin(Chunk, Chunk.id == Citation.chunk_id)
        )).all()
    return convos, links, messages, citations


def build_documents(convos, links, messages, citations) -> list[dict[str, Any]]:
    folders_by_convo: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for conversation_id, folder_id in links:
        folders_by_convo[conversation_id].append(folder_id)

    citations_by_msg: dict[uuid.UUID, list] = defaultdict(list)
    for c in citations:
        citations_by_msg[c.message_id].append(c)

    messages_by_convo: dict[uuid.UUID, list] = defaultdict(list)
    for m in messages:
        messages_by_convo[m.conversation_id].append(m)

    docs = []
    for cv in convos:
        # Oldest first. Tie-break user before assistant ('user' > 'assistant'),
        # though real ties should not occur: the old code committed the user
        # message before generating the answer.
        msgs = sorted(
            messages_by_convo[cv.id],
            key=lambda m: (m.created_at, 0 if m.role == "user" else 1),
        )
        embedded = [
            {
                "id": m.id,
                "role": str(m.role),
                "content": m.content,
                "created_at": m.created_at,
                "low_confidence": m.low_confidence,
                "retrieval_ms": m.retrieval_ms,
                # Always a list, even for user messages (design rule 4): the
                # messages.$[].citations.$[c] cleanup errors on a missing path.
                "citations": [
                    {
                        "rank": c.rank,
                        "score": c.score,
                        "chunk_id": c.chunk_id,
                        "file_id": c.file_id,
                        "folder_id": c.folder_id,
                        "excerpt_snapshot": c.excerpt_snapshot,
                        "source_label": c.source_label,
                    }
                    for c in sorted(citations_by_msg[m.id], key=lambda c: c.rank)
                ],
            }
            for m in msgs
        ]
        docs.append({
            "_id": cv.id,  # same UUID, so existing /conversations/{id} URLs keep working
            "user_id": cv.user_id,
            "title": cv.title,
            "folder_ids": folders_by_convo[cv.id],
            # Original timestamps, not now(). updated_at is corrected, though:
            # the ORM's onupdate only fired when the conversation row itself
            # changed (the first-turn title), never on message inserts, so it
            # is stale for any chat longer than one turn. chat_store bumps it
            # on every $push; match that meaning.
            "created_at": cv.created_at,
            "updated_at": max([cv.updated_at, *(m["created_at"] for m in embedded)]),
            "message_count": len(embedded),
            "messages": embedded,
        })
    return docs


async def write(docs: list[dict[str, Any]]) -> tuple[int, int]:
    inserted = replaced = 0
    for i in range(0, len(docs), BATCH):
        ops = [
            # user_id in the filter too (design rule 5). If this _id somehow
            # belonged to another user, the upsert fails on a duplicate _id
            # instead of silently overwriting their conversation.
            ReplaceOne({"_id": d["_id"], "user_id": d["user_id"]}, d, upsert=True)
            for d in docs[i:i + BATCH]
        ]
        result = await mongo.conversations.bulk_write(ops, ordered=True)
        inserted += result.upserted_count
        replaced += result.matched_count
    return inserted, replaced


async def verify(docs, n_messages: int, n_citations: int) -> bool:
    """Compare against the migrated _ids only: the collection also holds chats
    created natively in MongoDB since step 4, so a plain collection count would
    not match Postgres."""
    ids = [d["_id"] for d in docs]
    pipeline = [
        {"$match": {"_id": {"$in": ids}}},
        {"$group": {
            "_id": None,
            "docs": {"$sum": 1},
            "messages": {"$sum": "$message_count"},
            "embedded_messages": {"$sum": {"$size": "$messages"}},
            "citations": {"$sum": {"$sum": {
                "$map": {"input": "$messages", "as": "m", "in": {"$size": "$$m.citations"}}
            }}},
        }},
    ]
    got = await (await mongo.conversations.aggregate(pipeline)).to_list()
    got = got[0] if got else {"docs": 0, "messages": 0, "embedded_messages": 0, "citations": 0}

    checks = [
        ("conversations", len(docs), got["docs"]),
        ("messages (sum of message_count)", n_messages, got["messages"]),
        ("messages (embedded array sizes)", n_messages, got["embedded_messages"]),
        ("citations", n_citations, got["citations"]),
    ]
    print("\nverify (Postgres rows vs MongoDB)")
    ok = True
    for label, expected, actual in checks:
        match = expected == actual
        ok &= match
        print(f"  {'PASS' if match else 'FAIL'}  {label}: {expected} vs {actual}")
    return ok


async def main(dry_run: bool) -> int:
    engine.sync_engine.echo = False  # dev config echoes every SQL statement

    convos, links, messages, citations = await read_postgres()
    orphaned = sum(1 for c in citations if c.chunk_id is None)
    print("Postgres")
    print(f"  conversations         {len(convos)}")
    print(f"  conversation_folders  {len(links)}")
    print(f"  messages              {len(messages)}")
    print(f"  citations             {len(citations)}  ({orphaned} with source removed)")

    docs = build_documents(convos, links, messages, citations)
    print(f"\nbuilt {len(docs)} documents")

    if dry_run:
        if docs:
            sample = max(docs, key=lambda d: d["message_count"])
            print("\nsample (largest conversation, message content truncated):")
            preview = {**sample, "messages": [
                {**m, "content": m["content"][:80],
                 "citations": [{**c, "excerpt_snapshot": c["excerpt_snapshot"][:60]}
                               for c in m["citations"][:2]]}
                for m in sample["messages"][:2]
            ]}
            pprint(preview, sort_dicts=False, width=100)
        print("\n--dry-run: nothing written.")
        return 0

    if not docs:
        print("nothing to migrate.")
        return 0

    await mongo.ensure_indexes()
    inserted, replaced = await write(docs)
    print(f"written: {inserted} inserted, {replaced} replaced (rerun)")

    ok = await verify(docs, len(messages), len(citations))
    print("\nOK" if ok else "\nMISMATCH -- do not drop the Postgres tables.")
    return 0 if ok else 1


async def run(dry_run: bool) -> int:
    try:
        return await main(dry_run)
    finally:
        await mongo.client.close()
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="read and build, write nothing")
    raise SystemExit(asyncio.run(run(parser.parse_args().dry_run)))
