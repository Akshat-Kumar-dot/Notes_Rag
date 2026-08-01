# Note_Rag

Upload documents, then ask questions about them. Every answer shows the passages
it came from.

Two surfaces over one retrieval pipeline:

- **Search Notes** — hybrid retrieval only. No model, no rate limit, nothing
  invented: every word returned is something you uploaded.
- **Ask AI** — the same retrieval, then a grounded answer streamed over SSE with
  inline citations.

## Stack

| Layer | Choice |
|---|---|
| API | FastAPI (Python 3.12, async) |
| Database | Postgres + pgvector — vectors, full-text, auth, history in one place |
| Retrieval | Gemini embeddings (768d) + Postgres `tsvector`, fused with RRF |
| Generation | Gemini Flash, streamed |
| Parsing | PyMuPDF, python-docx, Tesseract, plaintext |
| Frontend | Next.js 15 static export, served by FastAPI |
| Deploy | One Docker service on Render + Neon + Google AI Studio (all free tier) |

## Run locally

```bash
cp .env.example backend/.env      # fill in six values
cd backend
python -m venv .venv && .venv\Scripts\Activate.ps1    # PowerShell
pip install -r requirements.txt
alembic upgrade head
```

Build the frontend into the backend (same origin, so cookies work):

```bash
cd ../frontend
npm install && npm run build
Remove-Item -Recurse -Force ..\backend\static -ErrorAction SilentlyContinue
Copy-Item -Recurse out ..\backend\static
cd ../backend && uvicorn app.main:app --reload
```

Open http://localhost:8000

## Environment

| Variable | Where from |
|---|---|
| `DATABASE_URL` | Neon → Connect → Connection string (paste verbatim) |
| `SECRET_KEY` | `python -c "import secrets; print(secrets.token_hex(32))"` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Cloud Console → Google Auth Platform → Clients |
| `GEMINI_API_KEY` | Google AI Studio → Get API key |
| `PUBLIC_BASE_URL` | `http://localhost:8000`, or your Render URL. No trailing slash. |

Google OAuth redirect URI must be `<PUBLIC_BASE_URL>/api/v1/auth/google/callback`.

## Deploy to Render

1. New **Web Service** → repo → Runtime **Docker** → **Region: Singapore**
   (match your Neon region; cross-region adds ~200ms to every query)
2. Set the six env vars above, plus `ENV=prod`
3. Add the Render callback URL to your Google OAuth client
4. Deploy

## Checks

- `/api/v1/health` → `{"ok":true,"env":"prod","pgvector":"0.8.x","gemini_configured":true}`
- Sign in → create folder → upload a `.md` → status reaches **Ready**
- Search Notes returns passages; Ask AI returns an answer with `[1]` markers
- Incognito → `/api/v1/auth/me` → 401

## Tests

```bash
cd backend && python -m pytest tests/ -q
```

Covers chunking (heading paths, page numbers, windowing, short sections) and
parsers (encoding fallback, docx tables, legacy `.doc` rejection).

See `ARCHITECTURE.md` for why each choice was made and what's still missing.

## Layout

```
backend/app/
  config.py db.py models.py schemas.py main.py
  auth/      google OAuth, session cookies, the fail-closed dependency
  api/       folders, files, search, chat (SSE)
  parsers/   one module per format behind a single interface
  rag/       chunking, embeddings, hybrid retrieval, prompting
  llm/       gemini client
  ingest.py  parse -> chunk -> embed -> store -> discard original
  storage.py /tmp staging for uploads
frontend/
  app/       landing (/) and workspace (/app)
  components/ Sidebar, Chat, Files, Icons
  lib/api.ts fetch wrappers + SSE parser
```
