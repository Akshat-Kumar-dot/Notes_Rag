"""Fill a production MongoDB (Atlas) with all chat history, in one run.

Run from backend/ with the venv active:

    python copy_mongo.py "mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/"
    python copy_mongo.py "mongodb+srv://..." --dry-run

Local dev and production share one Postgres but not one MongoDB, so chats live
in two places, and both are copied:

  1. Postgres -- chats from before the switch to MongoDB, including any made
     on the live site since (it kept writing to Postgres until it was updated).
  2. This machine's MongoDB -- chats made locally since the switch.

Safe to re-run. When a chat already exists on the target, the copy with more
messages wins, so a chat continued in either place is never cut short. Study-map
history is copied too; pending quizzes are not (they expire within a week).
"""
from __future__ import annotations

import argparse
import asyncio

from pymongo import AsyncMongoClient, ReplaceOne

from app.config import settings
from app.db import engine
from migrate_chat_to_mongo import build_documents, read_postgres


def client(url: str) -> AsyncMongoClient:
    # Same options as app/mongo.py, so UUIDs and dates round-trip unchanged.
    return AsyncMongoClient(url, uuidRepresentation="standard", tz_aware=True,
                            serverSelectionTimeoutMS=15_000)


async def _longer_wins(coll, docs: list[dict], label: str, dry_run: bool) -> None:
    ops, kept = [], 0
    for doc in docs:
        there = await coll.find_one({"_id": doc["_id"]}, {"message_count": 1})
        if there and there.get("message_count", 0) > doc.get("message_count", 0):
            kept += 1        # the target's copy is longer; keep it
            continue
        ops.append(ReplaceOne({"_id": doc["_id"]}, doc, upsert=True))
    print(f"chats {label}: {len(docs)} found, {len(ops)} to write, {kept} kept (longer on target)")
    if ops and not dry_run:
        r = await coll.bulk_write(ops, ordered=False)
        print(f"  written: {r.upserted_count} new, {r.modified_count} updated")


async def copy(target_url: str, dry_run: bool, target_db: str | None = None) -> None:
    engine.sync_engine.echo = False   # the dev config logs every SQL statement
    src_client, dst_client = client(settings.mongodb_url), client(target_url)
    src, dst = src_client[settings.mongodb_db], dst_client[target_db or settings.mongodb_db]
    try:
        await dst_client.admin.command("ping")   # fail early on a bad URL or IP allow-list

        local_docs = [d async for d in src["conversations"].find({})]
        pg_docs = build_documents(*await read_postgres())

        # Deleting a chat removes it from MongoDB only, so Postgres still has
        # every chat deleted locally since the migration. Copying those would
        # bring them back. A Postgres chat missing locally is a deletion if it
        # is no newer than the newest chat that made it across; anything newer
        # was made on the live site afterwards and must be kept.
        local_ids = {d["_id"] for d in local_docs}
        migrated = [d["created_at"] for d in pg_docs if d["_id"] in local_ids]
        cutoff = max(migrated) if migrated else None
        deleted = [d for d in pg_docs
                   if d["_id"] not in local_ids and cutoff and d["created_at"] <= cutoff]
        if deleted:
            print(f"skipping {len(deleted)} chats deleted on this machine since the migration: "
                  + ", ".join(repr(d["title"]) for d in deleted[:6]))
        pg_docs = [d for d in pg_docs if d not in deleted]

        await _longer_wins(dst["conversations"], pg_docs, "from Postgres", dry_run)
        await _longer_wins(dst["conversations"], local_docs, "from this machine's MongoDB", dry_run)

        events = [ReplaceOne({"_id": e["_id"]}, e, upsert=True) async for e in src["study_events"].find({})]
        print(f"study-map events: {len(events)} to write")
        if events and not dry_run:
            await dst["study_events"].bulk_write(events, ordered=False)

        total = await dst["conversations"].count_documents({})
        print(f"\ntarget now holds {total} chats" + (" (dry run: unchanged)" if dry_run else ""))
    finally:
        await src_client.close()
        await dst_client.close()
        await engine.dispose()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("target", help="connection string of the MongoDB to fill (Atlas)")
    ap.add_argument("--dry-run", action="store_true", help="count, write nothing")
    args = ap.parse_args()
    if args.target.rstrip("/") == settings.mongodb_url.rstrip("/"):
        raise SystemExit("That is the MongoDB this machine already uses. Pass the Atlas URL.")
    asyncio.run(copy(args.target, args.dry_run))
