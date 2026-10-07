"""How well each passage of a folder has been studied, from data we already keep.

Every cited answer records which passages it used (chat_store), and Teach me /
Quiz me record study events here. Each contributes a weight that halves every
HALF_LIFE_DAYS, so the map shows forgetting as well as what was never touched:

    strength(passage) = sum(weight * 0.5 ** (age_days / HALF_LIFE_DAYS))

    never seen          -> dark
    strength <  LIT     -> fading (studied once, a while ago)
    strength >= LIT     -> lit
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Literal

from app.mongo import conversations, quizzes, study_events

HALF_LIFE_DAYS = 7.0
LIT = 0.35

# One cited answer today is worth 1.0: lit for about two weeks, then fading.
CITED_TOP = 1.0      # among the top three sources of an answer
CITED_LOW = 0.5      # further down the list, where it mattered less
TEACH = 0.8


def quiz_weight(score: float) -> float:
    """A wrong answer still counts for a little (you have now read it); a
    correct one counts for most, since recall is the strongest signal."""
    return 0.3 + 1.7 * max(0.0, min(1.0, score))


async def strengths(
    user_id: uuid.UUID, folder_id: uuid.UUID
) -> dict[uuid.UUID, tuple[float, datetime]]:
    """chunk id -> (current strength, when last studied)."""
    now = datetime.now(UTC)
    acc: dict[uuid.UUID, list] = {}

    def add(chunk_id: uuid.UUID, weight: float, when: datetime) -> None:
        age_days = max(0.0, (now - when).total_seconds() / 86_400)
        s = weight * 0.5 ** (age_days / HALF_LIFE_DAYS)
        cur = acc.get(chunk_id)
        if cur is None:
            acc[chunk_id] = [s, when]
        else:
            cur[0] += s
            cur[1] = max(cur[1], when)

    # Citations from answers. Low-confidence answers are skipped: a "your notes
    # don't cover this" reply still lists its nearest passages, and those were
    # not actually studied.
    pipeline = [
        {"$match": {"user_id": user_id, "messages.citations.folder_id": folder_id}},
        {"$unwind": "$messages"},
        {"$match": {"messages.low_confidence": {"$ne": True}}},
        {"$unwind": "$messages.citations"},
        {"$match": {
            "messages.citations.folder_id": folder_id,
            "messages.citations.chunk_id": {"$ne": None},
        }},
        {"$project": {
            "_id": 0,
            "chunk_id": "$messages.citations.chunk_id",
            "rank": "$messages.citations.rank",
            "at": "$messages.created_at",
        }},
    ]
    async for r in await conversations.aggregate(pipeline):
        add(r["chunk_id"], CITED_TOP if r["rank"] <= 3 else CITED_LOW, r["at"])

    async for e in study_events.find({"user_id": user_id, "folder_id": folder_id}):
        add(e["chunk_id"], e["weight"], e["created_at"])

    return {k: (v[0], v[1]) for k, v in acc.items()}


async def record(
    user_id: uuid.UUID, folder_id: uuid.UUID, file_id: uuid.UUID,
    chunk_ids: list[uuid.UUID], kind: Literal["teach", "quiz"], weight: float,
) -> None:
    now = datetime.now(UTC)
    await study_events.insert_many([
        {"user_id": user_id, "folder_id": folder_id, "file_id": file_id,
         "chunk_id": c, "kind": kind, "weight": weight, "created_at": now}
        for c in chunk_ids
    ])


# ---- quizzes: asked now, answered later -------------------------------------


async def save_quiz(
    user_id: uuid.UUID, folder_id: uuid.UUID, file_id: uuid.UUID,
    chunk_ids: list[uuid.UUID], question: str, points: list[str],
) -> uuid.UUID:
    quiz_id = uuid.uuid4()
    await quizzes.insert_one({
        "_id": quiz_id, "user_id": user_id, "folder_id": folder_id, "file_id": file_id,
        "chunk_ids": chunk_ids, "question": question, "points": points,
        "answered": False, "created_at": datetime.now(UTC),
    })
    return quiz_id


async def claim_quiz(quiz_id: uuid.UUID, user_id: uuid.UUID) -> dict | None:
    """Mark a quiz answered and return it -- atomically, so the same quiz
    can't be graded twice by two parallel requests."""
    return await quizzes.find_one_and_update(
        {"_id": quiz_id, "user_id": user_id, "answered": False},
        {"$set": {"answered": True}},
    )


async def release_quiz(quiz_id: uuid.UUID) -> None:
    """Grading failed for reasons that were not the student's: let them retry."""
    await quizzes.update_one({"_id": quiz_id}, {"$set": {"answered": False}})


# ---- cleanup: no foreign keys across databases ------------------------------


async def forget_folder(user_id: uuid.UUID, folder_id: uuid.UUID) -> None:
    await study_events.delete_many({"user_id": user_id, "folder_id": folder_id})
    await quizzes.delete_many({"user_id": user_id, "folder_id": folder_id})


async def forget_file(user_id: uuid.UUID, file_id: uuid.UUID) -> None:
    await study_events.delete_many({"user_id": user_id, "file_id": file_id})
    await quizzes.delete_many({"user_id": user_id, "file_id": file_id})


async def forget_user(user_id: uuid.UUID) -> None:
    await study_events.delete_many({"user_id": user_id})
    await quizzes.delete_many({"user_id": user_id})
