# Handoff: moving chat history from Postgres to MongoDB

> For Claude Code. This file records a migration that is partly done:
> what was decided, what is built and verified, what is still left, and the
> traps already hit. Read it fully before changing anything under
> `backend/app/`. Nothing here has been committed yet (see "Git state").

## 1. Goal and the decision

Notes_Rag stored everything in one Neon Postgres database. **Chat history is
moving to MongoDB. Everything else stays in Postgres.**

| Stays in Postgres (Neon) | Moved to MongoDB |
|---|---|
| `users`, `sessions` (auth) | `conversations` table |
| `folders`, `files`, `file_texts` | `conversation_folders` → `folder_ids` array |
| `chunks` (pgvector HNSW + tsvector) | `messages` → embedded array |
| | `citations` → array inside each assistant message |

Why chat history, and only chat history:
- A conversation is nested, grows by appending, and is always read as a whole,
  which suits a single embedded document.
- **Neon's free tier is about 0.5 GB for everything.** Vectors are already the
  biggest consumer. Chat history (with 700-character citation snapshots) grows
  without limit, and moving it to Atlas M0 (a separate 512 MB) roughly doubles
  the free headroom.
- **Vectors must stay in Postgres.** Self-hosted MongoDB has no vector index
  (Vector Search exists only on Atlas). Keeping chunks and embeddings in one
  Postgres transaction is also what prevents index/source drift.
- Retrieval (`rag/retrieval.py`, hybrid dense + sparse with RRF) is **unchanged**
  apart from one extra column.

The owner is also taking a NoSQL course (MongoDB). He wants the reasoning
explained step by step, not just a code dump.

## 2. Document shape (collection `notes_rag.conversations`)

```javascript
{
  _id: UUID,                 // the SAME uuid4 Postgres used, so API URLs are unchanged
  user_id: UUID,             // users.id from Postgres
  title: "New chat",
  folder_ids: [UUID, ...],   // was conversation_folders; fixed at creation
  created_at: ISODate, updated_at: ISODate,
  message_count: 2,          // Computed pattern, $inc on every push
  messages: [
    { id: UUID, role: "user", content: "...", created_at: ISODate,
      low_confidence: false, retrieval_ms: null, citations: [] },
    { id: UUID, role: "assistant", content: "...", created_at: ISODate,
      low_confidence: false, retrieval_ms: 184,
      citations: [
        { rank: 1, score: 0.81, chunk_id: UUID | null,
          file_id: UUID, folder_id: UUID,
          excerpt_snapshot: "...", source_label: "nosql.pdf, p.4" }
      ] }
  ]
}
```

Indexes (created at startup by `mongo.ensure_indexes()`):
- `{ user_id: 1, updated_at: -1 }` serves the sidebar list. Verified with
  `explain()`: IXSCAN with **no SORT stage**.
- `{ user_id: 1, folder_ids: 1 }` (multikey) serves the folder-delete cleanup.

Design rules; keep them:
1. **`_id` is the Postgres UUID, not an ObjectId.** The frontend and the `done`
   SSE event already use UUIDs. The migration must reuse the existing IDs.
2. **Citations keep their snapshots** (`excerpt_snapshot`, `source_label`), so
   old answers stay readable after the source file is deleted. `chunk_id: null`
   means "source removed", and the frontend already handles it
   (`Chat.tsx` falls back to `${m.id}-${c.rank}` as the key).
3. **Citations carry `file_id` and `folder_id`.** These replace the Postgres
   foreign key, which cannot cross databases.
4. **User messages always have `citations: []`, never a missing field.** The
   cleanup update uses the path `messages.$[].citations.$[c]`, and MongoDB errors
   if that path is absent on any array element. Any migrated message must follow
   this rule too.
5. **Every query filters on `user_id` as well as `_id`.** That is the
   tenant-isolation rule the SQL version enforced.
6. `updated_at` is set explicitly on every write. MongoDB has no `onupdate`.
7. The Outlier pattern is **not** implemented. At roughly 6–7 KB per assistant
   turn, the 16 MB document limit is about 2,000 turns away. Only add an
   overflow collection if that ever matters.

## 3. What is done (steps 1–4)

### Step 1: schema designed and proven in mongosh
Run against the owner's real local MongoDB 8.3.11:
- `$push` + `$inc` + `$set` turn writes worked.
- `$slice: -6` history projection worked.
- `arrayFilters` nulled `chunk_id` **only** on citations of the deleted file.
  In a message citing file A and file B, only A was touched. (An earlier run had
  a typo, `arrarrayFilters`, which MongoDB silently ignored. The re-run with the
  correct spelling is the one that proved it.)

### Step 2: backend connected
- `backend/requirements.txt`: added `pymongo>=4.13` (4.18.2 installed). Uses
  **PyMongo's native `AsyncMongoClient`, not Motor**. Motor is deprecated in
  favour of it.
- `backend/app/config.py`: added `mongodb_url` (default
  `mongodb://localhost:27017`) and `mongodb_db` (default `notes_rag`).
- `backend/app/mongo.py` (new): client with `uuidRepresentation="standard"`
  (without it PyMongo refuses to encode `uuid.UUID`) and `tz_aware=True`
  (without it datetimes come back naive, serialise without an offset, and the
  browser shows every time 5h30m off in IST). Also defines `ensure_indexes()`.
- `backend/app/main.py`: added a lifespan handler (ensure indexes on start,
  close client on shutdown). `/api/v1/health` now also returns `"mongodb": bool`.

### Step 3: repository layer
`backend/app/chat_store.py` (new) is the only module that talks to the
collection:

| Function | Replaces |
|---|---|
| `create_conversation` | INSERT conversations + conversation_folders |
| `list_conversations` | sidebar list (messages projected out) |
| `get_conversation` | selectinload messages → citations |
| `delete_conversation` | DELETE + cascades |
| `load_for_turn` | "last 6 messages" query, via `$slice` |
| `append_user_message` | INSERT messages |
| `append_assistant_message` | message + N citations + title in **one atomic update_one** |
| `detach_file` | `citations.chunk_id ON DELETE SET NULL` |
| `detach_folder` | the same by `folder_id`, plus `$pull` from `folder_ids` |
| `delete_user_conversations` | users → conversations cascade (**not yet called anywhere**, since no user-delete endpoint exists) |

`backend/try_chat_store.py` (new) is a standalone smoke test against the real
local MongoDB. It uses random UUIDs and cleans up after itself. **All 19 checks
passed** on the owner's machine:
`cd backend; .venv\Scripts\Activate.ps1; python try_chat_store.py`

### Step 4: endpoints switched
- `backend/app/api/chat.py`: all five endpoints use `chat_store`. Postgres is
  still used here, but only to check folder ownership on create and to run
  `retrieve()`. `_generate` no longer holds a Postgres session for the whole
  stream; it opens `SessionLocal()` only around `retrieve()`. The SSE contract
  (`sources` → `token`* → `done` / `error`) and all response shapes are
  unchanged, so the frontend needs no changes.
- `backend/app/rag/retrieval.py`: `Hit` gained `folder_id` (the SQL now also
  selects `c.folder_id`).
- `backend/app/api/files.py` / `folders.py`: delete now does
  `db.delete → await db.commit() → chat_store.detach_*`. The commit comes
  **first on purpose**: `get_db` otherwise commits only at teardown, and
  cleaning MongoDB before a Postgres commit that then fails would mark live
  sources as removed. This follows the repo's existing "upload commits before
  scheduling the background task" lesson.
- Checked: asyncpg's `pgproto.UUID` (from raw-SQL rows) subclasses `uuid.UUID`
  and BSON-encodes correctly, so no conversion is needed.

**Verified end to end in the browser on localhost:** signed in, created a chat,
asked "hello". Sources streamed (4 chunks from `README_1.md`), and the answer
streamed ("The provided excerpts do not contain an answer…", which is correct
because `hello` is low-confidence). Still to be confirmed by the owner: reload
persistence, and `message_count: 2` on that document in mongosh.

Why "hello" returned 4 sources all scoring 0.016: the sparse arm matched
nothing, so the RRF scores are dense-only (1/61, 1/62, 1/63, 1/64, which all
round to 0.016), and that folder only contains 4 chunks. Vector search always
returns the nearest chunks, even when none are close. **This is not a bug.**
Optionally, show 4 decimals or the dense cosine in the UI.

## 4. What is left

### Step 5: migrate existing Postgres conversations ✅ done locally (28 Sep 2026)
`backend/migrate_chat_to_mongo.py` ran against the local Neon DB → local
MongoDB: 29 conversations, 109 messages, 295 citations (18 with source
removed). All count checks passed; a rerun reported `0 inserted, 29 replaced`
(idempotent). A separate field-by-field comparison of every conversation,
message and citation found no differences, and the `messages.$[].citations.$[c]`
cleanup path ran over all 29 docs without error (rule 4 holds). Listing,
fetching and `load_for_turn` through the API schemas all passed. **Still to
confirm visually in the browser (needs sign-in).** Postgres was only read, so the
old tables are intact for step 6.

Deviations from the original plan below:
- **`updated_at` is corrected, not copied.** The ORM's `onupdate=func.now()`
  only fired when the conversation *row* changed (the first-turn title), never
  on message inserts, so 12 of 29 chats had a stale value. The script uses
  `max(updated_at, last message created_at)`, matching `chat_store`, which
  bumps it on every `$push`.
- **Verification is scoped to the migrated `_id`s.** The collection also holds
  chats created natively since step 4, so a whole-collection count never
  matches Postgres.
- Stray doc: `"CAP doubts"` (2 messages), whose `user_id` is not in Postgres.
  It is almost certainly left over from the step 1 mongosh experiment. No user
  can see it. Delete it once the owner confirms.

Original plan:
- Read `conversations` + `conversation_folders` + `messages` + `citations` with
  plain SQLAlchemy (the ORM models still exist in `models.py`).
- Build one document per conversation with **the same UUIDs** (`_id`, message
  `id`, `chunk_id`). Messages are ordered by `created_at` and citations by `rank`.
- Citations do not store `file_id`/`folder_id` in Postgres. Fill them by
  joining `citations.chunk_id → chunks.file_id, chunks.folder_id`. If
  `chunk_id` is already NULL (source deleted), set both to `None`; the snapshot
  is still there.
- User messages get `citations: []`. `message_count = len(messages)`.
- Make it **idempotent**: use `replace_one({_id}, doc, upsert=True)` so reruns
  are safe. Print counts per table versus documents written, and add a
  `--dry-run` flag.
- Verify: the number of conversations in Postgres equals the number of
  documents, and summed `message_count` equals the number of messages rows.

### Step 6: drop the old tables (only after step 5 is verified)
- **Revision 0003 is taken** by `0003_guest_trials.py` (the free guest trial,
  added 28 Sep 2026). Add `backend/alembic/versions/0004_chat_to_mongodb.py`
  (down_revision `"0003"`).
- **Shared-database trap:** local `.env` points at the same Neon DB Render
  uses. Render's CMD runs `alembic upgrade head` on every boot and fails if the
  DB is at a revision the deployed code doesn't have. So the guest tables exist
  but `alembic_version` is deliberately stamped `0002`, and 0003 skips creation
  when the tables already exist. Never leave the shared DB at a revision newer
  than what Render runs. For 0004 (which drops tables the deployed code still
  reads), run it only as part of the deploy, not from a dev machine. It drops `citations`, `messages`, `conversation_folders` and
  `conversations`, in that order. Its `downgrade` recreates them from
  `0002_documents_and_chat.py`.
- Remove `Conversation`, `Message`, `Citation`, `Role` and
  `conversation_folders` from `models.py`. Nothing else imports them now:
  `chat.py` was the only user, and `schemas.py` has its own pydantic classes.

### Step 7: production (Render + Atlas)
- Create an Atlas M0 cluster in the **Singapore** region, to sit near Neon and
  Render. Create a DB user, and allow network access for Render (Render's free
  tier has no static egress IP, so this is usually `0.0.0.0/0` plus a strong
  password).
- `render.yaml`: add `MONGODB_URL` (`sync: false`). `.env.example`: add
  `MONGODB_URL` with a placeholder. The code defaults to localhost, so prod
  **must** set it.
- Fill Atlas before the new code goes live, or chats vanish in prod:
  `python copy_mongo.py "<atlas url>"` (from backend/, venv active). One run
  copies chats still in Postgres (including any made on the live site after
  the local migration) and chats made locally in MongoDB; the longer copy of a
  chat wins, and chats deleted locally since the migration are not revived.
  Tested against a throwaway database on 8 Oct 2026: 27 chats = 26 local + 1
  made on the live site, 5 locally deleted skipped.
- **What went wrong on 8 Oct 2026:** "Update UI" was pushed before Atlas
  existed. Render's CMD ran `alembic upgrade head` (stamping the shared DB to
  0003), then the app died trying to reach MongoDB on localhost. The previous
  deploy stayed live but would have failed its next cold start on 0003, so the
  DB was stamped back to 0002. The app now refuses to start in prod without a
  real MONGODB_URL, and that check runs inside alembic too, before it touches
  the database.

### Step 8: docs and tests
- `ARCHITECTURE.md`: update the request path ("persist message + citation rows"
  becomes a MongoDB `$push`), and add a "Decisions worth defending" entry for
  the split and the cross-database cleanup.
- Consider turning `try_chat_store.py` into a pytest test (skip if MongoDB is
  unreachable). The existing `tests/conftest.py` only sets env vars.

## 5. Environment facts and traps already hit

- **The owner is on Windows**, using PowerShell and Python 3.13.5 from Anaconda.
  The venv is `backend\.venv` and must be activated in every new terminal:
  `.venv\Scripts\Activate.ps1`. Symptom of forgetting:
  `ModuleNotFoundError: No module named 'pymongo'`.
- The venv was **rebuilt** because the project moved from `Desktop\Note_Rag` to
  `Desktop\01_Projects\Note_Rag`, and venv launchers hard-code their path.
- Local MongoDB 8.3.11 runs as the Windows service `MongoDB` on
  `127.0.0.1:27017` with no auth (normal for local dev). mongosh 2.12.0. In
  mongosh, `use notes_rag` must be on its own line; inside a pasted block it is
  a syntax error.
- **`backend/.env` `PUBLIC_BASE_URL` was changed** from
  `https://note-rag.onrender.com` to `http://localhost:8000`. It had been causing
  `redirect_uri_mismatch` on local login. The file is gitignored, and Render
  uses its own env vars.
- Google OAuth client (project number `621739320428`), authorised redirect
  URIs: `http://localhost:8000/api/v1/auth/google/callback` ✅ and
  `https://notes-rag.onrender.com/...` ⚠️. **That second one is a typo**: the
  service is `note-rag` (see `render.yaml`), so production sign-in is probably
  broken. The owner was told to add the exact Render URL. Confirm it is fixed.
- Always test at `http://localhost:8000`, not `127.0.0.1`, because cookies are
  host-bound.
- `frontend/tsconfig.json` has an unrelated pre-existing uncommitted change by
  the owner. Leave it alone.

## 6. Git state

Nothing is committed. Last commit `4b8fb27` (1 Aug 2026). Uncommitted:

```
M  backend/app/api/chat.py        (rewritten on chat_store)
M  backend/app/api/files.py       (commit + detach_file)
M  backend/app/api/folders.py     (commit + detach_folder)
M  backend/app/config.py          (mongodb_url, mongodb_db)
M  backend/app/main.py            (lifespan, /health mongodb)
M  backend/app/rag/retrieval.py   (Hit.folder_id)
M  backend/requirements.txt       (pymongo>=4.13)
?? backend/app/chat_store.py
?? backend/app/mongo.py
?? backend/try_chat_store.py
?? backend/migrate_chat_to_mongo.py  (step 5)
?? MONGODB_MIGRATION.md           (this file)
```

A reasonable first commit, once the owner confirms persistence: everything
above except `frontend/tsconfig.json` and `.claude/`, with a message like
"Move chat history to MongoDB (steps 1–4)". Ask the owner before committing or
pushing.
