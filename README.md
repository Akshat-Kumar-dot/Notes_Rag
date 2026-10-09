# Notes Rag

I kept pasting my lecture notes into chatbots and getting answers that sounded
right but weren't actually in my notes. So I built this. You upload your own
files, ask questions, and it answers only from what you uploaded. Every sentence
in the answer is linked to the exact passage it came from, so you can check it
instead of trusting it.

Live: https://notes-rag.akshat-kumar-singh05.workers.dev

## What it does

- **Ask AI**: ask in plain language and get an answer streamed back with
  numbered citations. Each number points to the passage it used, listed
  under the answer with the file name and page.
- **Search Notes**: the same search, but no AI at all. It just returns the
  matching passages from your files, so nothing can be made up.
- **Says when it doesn't know**: if your files don't cover the question, the
  answer is marked low confidence instead of confidently invented.
- **Study map**: every passage of your notes as a grid. It lights up where
  you've studied, stays dark where you haven't, and fades as time passes.
- **Teach me / quiz me**: pick a dark spot on the map and it explains that
  part, or asks you a question and marks your answer against your notes.
- **Chat graph**: chats that used the same passages get linked, so related
  questions stay together.
- **Folders**: each chat is scoped to the folders you pick, so an answer
  about one course doesn't leak in from another.
- **Free trial without signing in**: one document and two questions. Limits
  are per device and per network with daily caps, so nobody can burn through
  my API quota.
- Voice input, past chats you can pick up again, and a sidebar that remembers
  its width.

It reads PDFs, Word files (.docx), Markdown and plain text, and images
(PNG/JPG/WebP) through OCR.

## How it works (the short version)

1. Upload: the file is parsed, split into ~450-token chunks that keep their
   headings and page numbers, embedded with Gemini, and stored in Postgres.
   The original file is thrown away after that.
2. Ask: your question goes through two searches at once, vector similarity
   (pgvector) and keyword search (Postgres full-text). The two result lists are
   merged with Reciprocal Rank Fusion. The keyword side is what catches names,
   formulas and course codes that embeddings miss.
3. Answer: the top passages go to Gemini with strict instructions to only use
   them and cite them. The answer streams back over SSE.

Chat history, study events and quizzes live in MongoDB. Users, folders, files
and chunks live in Postgres.

## Stack

| Part | What I used |
|---|---|
| API | FastAPI, Python 3.12, async SQLAlchemy |
| Main database | Postgres + pgvector on Neon |
| Chat history | MongoDB (Atlas in production) |
| Search | Gemini embeddings (768d) + Postgres full-text, merged with RRF |
| Answers | Gemini Flash, streamed |
| Parsing | PyMuPDF, python-docx, Tesseract for images |
| Frontend | Next.js 15 static export |
| Landing page | Lenis smooth scroll, three.js for the chrome page stack |
| Hosting | Frontend on a Cloudflare Worker, API on Render (Docker) |

Everything runs on free tiers.

## Running it locally

You need Python 3.12, Node 22, and MongoDB running locally (or point
`MONGODB_URL` at Atlas).

```bash
cp .env.example backend/.env
```

Fill in the values (see the table below), then set up the backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
```

Build the frontend and copy it into the backend, so the page and the API are
on the same origin and the login cookie works:

```bash
cd ../frontend
npm install
npm run build
Remove-Item -Recurse -Force ..\backend\static -ErrorAction SilentlyContinue
Copy-Item -Recurse out ..\backend\static
```

Then start it:

```bash
cd ../backend
uvicorn app.main:app --reload
```

Open http://localhost:8000.

## Environment variables

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Neon → Connect → connection string (paste it as is) |
| `MONGODB_URL` | `mongodb://localhost:27017` locally, Atlas connection string in production |
| `SECRET_KEY` | `python -c "import secrets; print(secrets.token_hex(32))"` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console → Google Auth Platform → Clients |
| `GEMINI_API_KEY` | Google AI Studio → Get API key |
| `PUBLIC_BASE_URL` | `http://localhost:8000` locally, the site's address in production. No trailing slash. |
| `ENV` | `dev` locally, `prod` in production |
| `CHAT_MODEL` | Optional. I use `gemini-flash-lite-latest` in production. |
| `TRUSTED_PROXY_HOPS` | `0` locally, `1` on Render |
| `PROXY_SECRET` | Production only. The same value goes in the Cloudflare Worker as a secret. |

The Google OAuth redirect URI has to be `<PUBLIC_BASE_URL>/api/v1/auth/google/callback`.

## Deploying

There are two parts.

**The API on Render.** Create the service from `render.yaml` (New → Blueprint)
and it will ask for the secrets. Keep the region the same as your Neon
database, or every query gets slower. Migrations run on boot. If `ENV=prod` and
`MONGODB_URL` is missing, the app refuses to start on purpose.

**The frontend on Cloudflare.** `frontend/wrangler.jsonc` serves the static
site and forwards `/api/*` to Render. Put your Render address in `API_ORIGIN`,
then from `frontend/`:

```bash
npx wrangler secret put PROXY_SECRET
```

```bash
npm run deploy
```

If Workers Builds is connected to the repo (root folder `frontend`), pushing
to GitHub deploys it for you.

Health check: `/api/v1/health` should return `"ok": true` with `"env": "prod"`.

## Tests

```bash
cd backend
python -m pytest tests/ -q
```

They cover chunking (headings, page numbers, overlap, short sections) and the
parsers (text encodings, Word tables, rejecting old `.doc` files).

## Where things are

```
backend/app/
  main.py          app setup, cache headers, routes
  config.py        all settings in one place
  auth/            Google login, sessions, the guest trial
  api/             folders, files, search, chat (SSE), study map and quizzes
  parsers/         one file per format
  rag/             chunking, embeddings, hybrid search, prompts
  llm/             Gemini client
  chat_store.py    chat history in MongoDB
  study_store.py   study events and quizzes in MongoDB
  ingest.py        parse -> chunk -> embed -> store
frontend/
  app/             landing page (/) and the workspace (/app)
  components/      sidebar, chat, files, study map, chat graph, landing scenes
  lib/             API client, dictation, scroll helpers
  worker/          the Cloudflare Worker that proxies /api
```

`ARCHITECTURE.md` explains why I made the choices I did, `BACKLOG.md` is what
I still want to build, and `MONGODB_MIGRATION.md` covers how chat history moved
from Postgres to MongoDB.
