"""MongoDB connection for chat history.

Postgres keeps users, files, chunks and vectors. Conversations live here as one
document each, with messages and citations embedded.
"""

from pymongo import AsyncMongoClient

from app.config import settings

client = AsyncMongoClient(
    settings.mongodb_url,
    # Store uuid.UUID as BSON binary subtype 4 -- the same UUID('...') values
    # mongosh shows. Without this PyMongo refuses to encode UUIDs at all.
    uuidRepresentation="standard",
    # Return timezone-aware datetimes like Postgres does. Naive UTC would be
    # serialised without an offset and the browser would read it as local time.
    tz_aware=True,
)
mdb = client[settings.mongodb_db]
conversations = mdb["conversations"]
# Study map: every Teach me / Quiz me on a passage, and quizzes awaiting an answer.
study_events = mdb["study_events"]
quizzes = mdb["quizzes"]


async def ensure_indexes() -> None:
    """Idempotent: create_index is a no-op when the index already exists."""
    # sidebar list: a user's conversations, newest first (no in-memory sort)
    await conversations.create_index([("user_id", 1), ("updated_at", -1)])
    # folder-delete cleanup: $pull the folder from every conversation using it
    await conversations.create_index([("user_id", 1), ("folder_ids", 1)])
    # study map: which passages of a folder a user's answers have cited
    await conversations.create_index([("user_id", 1), ("messages.citations.folder_id", 1)])
    await study_events.create_index([("user_id", 1), ("folder_id", 1)])
    # an unanswered quiz is worthless after a week; MongoDB deletes it itself
    await quizzes.create_index("created_at", expireAfterSeconds=7 * 86_400)
