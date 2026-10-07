"""Chat history in MongoDB: one document per conversation.

Replaces the Postgres tables conversations, conversation_folders, messages and
citations. Postgres keeps users, folders, files and chunks.

    {
      _id, user_id, title, folder_ids[], created_at, updated_at, message_count,
      messages: [
        {id, role, content, created_at, low_confidence, retrieval_ms,
         citations: [{rank, score, chunk_id, file_id, folder_id,
                      excerpt_snapshot, source_label}]}
      ]
    }

Every query filters on user_id as well as _id, so one user can never read or
modify another user's conversation -- the same rule the SQL version enforced.

Postgres foreign keys used to clean up after deletes. MongoDB cannot reference
across databases, so the delete paths call detach_file / detach_folder /
delete_user_conversations explicitly.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from app.mongo import conversations

NEW_CHAT_TITLE = "New chat"


def _now() -> datetime:
    return datetime.now(UTC)


def _out(doc: dict[str, Any]) -> dict[str, Any]:
    """Rename Mongo's _id to the id field the API schemas expect."""
    doc["id"] = doc.pop("_id")
    return doc


# ------------------------------------------------------------ conversations


async def create_conversation(
    user_id: uuid.UUID, folder_ids: list[uuid.UUID], title: str | None = None
) -> dict[str, Any]:
    now = _now()
    doc = {
        "_id": uuid.uuid4(),
        "user_id": user_id,
        "title": title or NEW_CHAT_TITLE,
        "folder_ids": folder_ids,
        "created_at": now,
        "updated_at": now,
        "message_count": 0,
        "messages": [],
    }
    await conversations.insert_one(doc)
    return _out(doc)


async def list_conversations(user_id: uuid.UUID, limit: int = 100) -> list[dict[str, Any]]:
    """Sidebar list, newest first. Served by the {user_id, updated_at} index
    with no in-memory sort. Messages are projected out -- the sidebar never
    needs them, and they are most of each document's size."""
    cursor = (
        conversations.find({"user_id": user_id}, {"messages": 0})
        .sort("updated_at", -1)
        .limit(limit)
    )
    return [_out(d) async for d in cursor]


async def graph_rows(user_id: uuid.UUID, limit: int = 300) -> list[dict[str, Any]]:
    """Chats with just what the chat graph needs: which passages and files
    each answer cited. Message text stays in the database."""
    cursor = (
        conversations.find(
            {"user_id": user_id},
            {"title": 1, "folder_ids": 1, "message_count": 1, "updated_at": 1,
             "messages.low_confidence": 1, "messages.citations.chunk_id": 1,
             "messages.citations.file_id": 1, "messages.citations.source_label": 1},
        )
        .sort("updated_at", -1)
        .limit(limit)
    )
    return [d async for d in cursor]


async def count_conversations(user_id: uuid.UUID) -> int:
    return await conversations.count_documents({"user_id": user_id})


async def get_conversation(
    conversation_id: uuid.UUID, user_id: uuid.UUID
) -> dict[str, Any] | None:
    doc = await conversations.find_one({"_id": conversation_id, "user_id": user_id})
    return _out(doc) if doc else None


async def delete_conversation(conversation_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    result = await conversations.delete_one({"_id": conversation_id, "user_id": user_id})
    return result.deleted_count == 1


# --------------------------------------------------------------- a chat turn


async def load_for_turn(
    conversation_id: uuid.UUID, user_id: uuid.UUID, history_n: int = 6
) -> dict[str, Any] | None:
    """Everything _generate needs before answering: folder scope, title, and
    only the last `history_n` messages -- $slice trims them server-side, so a
    500-message conversation does not cross the wire to build a 6-message
    prompt."""
    doc = await conversations.find_one(
        {"_id": conversation_id, "user_id": user_id},
        {"messages": {"$slice": -history_n}},
    )
    return _out(doc) if doc else None


async def append_user_message(
    conversation_id: uuid.UUID, user_id: uuid.UUID, content: str
) -> uuid.UUID:
    message_id = uuid.uuid4()
    await conversations.update_one(
        {"_id": conversation_id, "user_id": user_id},
        {
            "$push": {
                "messages": {
                    "id": message_id,
                    "role": "user",
                    "content": content,
                    "created_at": _now(),
                    "low_confidence": False,
                    "retrieval_ms": None,
                    # Always an array, never missing: the $[] update in
                    # detach_file errors if the path is absent on any message.
                    "citations": [],
                }
            },
            "$inc": {"message_count": 1},
            "$set": {"updated_at": _now()},
        },
    )
    return message_id


async def append_assistant_message(
    conversation_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    content: str,
    low_confidence: bool,
    retrieval_ms: int | None,
    citations: list[dict[str, Any]],
    title: str | None = None,
) -> uuid.UUID:
    """One atomic write: the answer, its citations, the counter, the timestamp
    and (on the first turn) the title. In Postgres this was a message insert,
    N citation inserts and a conversation update inside one transaction; here a
    single-document update is atomic on its own.

    Each citation dict must carry: rank, score, chunk_id, file_id, folder_id,
    excerpt_snapshot, source_label.
    """
    message_id = uuid.uuid4()
    update: dict[str, Any] = {
        "$push": {
            "messages": {
                "id": message_id,
                "role": "assistant",
                "content": content,
                "created_at": _now(),
                "low_confidence": low_confidence,
                "retrieval_ms": retrieval_ms,
                "citations": citations,
            }
        },
        "$inc": {"message_count": 1},
        "$set": {"updated_at": _now()},
    }
    if title:
        update["$set"]["title"] = title
    await conversations.update_one({"_id": conversation_id, "user_id": user_id}, update)
    return message_id


# ------------------------------------------- cleanup after Postgres deletes
# These replace ON DELETE SET NULL / CASCADE, which cannot cross databases.
# Snapshots (excerpt_snapshot, source_label) are kept, so old answers stay
# readable; chunk_id = null is what the UI reads as "source removed".


async def detach_file(user_id: uuid.UUID, file_id: uuid.UUID) -> int:
    """A file was deleted: null chunk_id on every citation that pointed into it."""
    result = await conversations.update_many(
        {"user_id": user_id, "messages.citations.file_id": file_id},
        {"$set": {"messages.$[].citations.$[c].chunk_id": None}},
        array_filters=[{"c.file_id": file_id}],
    )
    return result.modified_count


async def detach_folder(user_id: uuid.UUID, folder_id: uuid.UUID) -> int:
    """A folder was deleted (and with it, all its files): null the citations
    that pointed into it, and drop it from every conversation's scope -- the
    old conversation_folders ON DELETE CASCADE."""
    await conversations.update_many(
        {"user_id": user_id, "messages.citations.folder_id": folder_id},
        {"$set": {"messages.$[].citations.$[c].chunk_id": None}},
        array_filters=[{"c.folder_id": folder_id}],
    )
    result = await conversations.update_many(
        {"user_id": user_id, "folder_ids": folder_id},
        {"$pull": {"folder_ids": folder_id}},
    )
    return result.modified_count


async def delete_user_conversations(user_id: uuid.UUID) -> int:
    """A user was deleted: the old users -> conversations ON DELETE CASCADE."""
    result = await conversations.delete_many({"user_id": user_id})
    return result.deleted_count
