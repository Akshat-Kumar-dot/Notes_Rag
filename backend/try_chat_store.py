"""Smoke test for app/chat_store.py against your local MongoDB.

Run from backend/ with the venv active:   python try_chat_store.py

Uses random UUIDs and deletes everything it created at the end, so it is safe
to run against the real notes_rag database.
"""
import asyncio
import uuid

from app import chat_store, mongo


def check(label: str, ok: bool) -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        raise SystemExit(1)


async def main() -> None:
    await mongo.ensure_indexes()
    user, other_user = uuid.uuid4(), uuid.uuid4()
    folder_a, folder_b = uuid.uuid4(), uuid.uuid4()
    file_a, file_b = uuid.uuid4(), uuid.uuid4()

    try:
        print("create + list")
        convo = await chat_store.create_conversation(user, [folder_a, folder_b])
        cid = convo["id"]
        check("new conversation is titled 'New chat'", convo["title"] == "New chat")
        listed = await chat_store.list_conversations(user)
        check("list returns it", [c["id"] for c in listed] == [cid])
        check("list leaves messages out", "messages" not in listed[0])

        print("ownership")
        check("another user cannot read it",
              await chat_store.get_conversation(cid, other_user) is None)
        check("another user cannot delete it",
              await chat_store.delete_conversation(cid, other_user) is False)

        print("a chat turn")
        await chat_store.append_user_message(cid, user, "what is CAP?")
        await chat_store.append_assistant_message(
            cid, user, content="CAP says...", low_confidence=False, retrieval_ms=184,
            title="what is CAP?",
            citations=[
                {"rank": 1, "score": 0.81, "chunk_id": uuid.uuid4(), "file_id": file_a,
                 "folder_id": folder_a, "excerpt_snapshot": "from A", "source_label": "a.pdf"},
                {"rank": 2, "score": 0.74, "chunk_id": uuid.uuid4(), "file_id": file_b,
                 "folder_id": folder_b, "excerpt_snapshot": "from B", "source_label": "b.pdf"},
            ],
        )
        full = await chat_store.get_conversation(cid, user)
        check("title set on first turn", full["title"] == "what is CAP?")
        check("message_count is 2", full["message_count"] == 2)
        check("datetimes are timezone-aware", full["updated_at"].tzinfo is not None)
        check("UUIDs come back as uuid.UUID", isinstance(full["messages"][0]["id"], uuid.UUID))

        print("history slice")
        for i in range(4):
            await chat_store.append_user_message(cid, user, f"follow-up {i}")
        turn = await chat_store.load_for_turn(cid, user, history_n=6)
        check("only the last 6 messages returned", len(turn["messages"]) == 6)
        check("slice is the newest end", turn["messages"][-1]["content"] == "follow-up 3")
        check("folder scope comes along", turn["folder_ids"] == [folder_a, folder_b])

        print("delete file A")
        await chat_store.detach_file(user, file_a)
        cites = (await chat_store.get_conversation(cid, user))["messages"][1]["citations"]
        check("file A citation lost its chunk_id", cites[0]["chunk_id"] is None)
        check("file A snapshot kept", cites[0]["excerpt_snapshot"] == "from A")
        check("file B citation untouched", cites[1]["chunk_id"] is not None)

        print("delete folder B")
        await chat_store.detach_folder(user, folder_b)
        full = await chat_store.get_conversation(cid, user)
        check("folder B citation lost its chunk_id",
              full["messages"][1]["citations"][1]["chunk_id"] is None)
        check("folder B removed from scope", full["folder_ids"] == [folder_a])

        print("delete conversation")
        check("owner can delete it", await chat_store.delete_conversation(cid, user))
        check("it is gone", await chat_store.get_conversation(cid, user) is None)

        print("\nall checks passed")
    finally:
        await chat_store.delete_user_conversations(user)
        await mongo.client.close()


if __name__ == "__main__":
    asyncio.run(main())
