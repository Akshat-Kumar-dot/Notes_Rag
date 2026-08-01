# notes_rag

Slice 1: Google sign-in, revocable sessions, deployed as a single service.

## Run locally

```bash
cp .env.example .env          # fill in the five values
cd backend
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload
```

Backend alone runs at http://localhost:8000 — visit
`/api/v1/auth/google/login` and the whole OAuth flow works with no frontend.

For the frontend during development:

```bash
cd frontend && npm install && npm run dev   # localhost:3000
```

Note that `next dev` runs on a different port, so cookies won't be same-origin.
For an accurate test, build it into the backend instead:

```bash
cd frontend && npm run build && cp -r out ../backend/static
```

## Deploy to Render

1. New **Web Service** → your repo → Runtime **Docker**
2. Environment: `ENV=prod`, plus the five variables from `.env.example`
3. `PUBLIC_BASE_URL` must be your exact Render URL, no trailing slash
4. Add that same URL + `/api/v1/auth/google/callback` to your Google OAuth
   client's authorized redirect URIs

## Check it worked

- `GET /api/v1/health` → `{"ok": true, "pgvector": "0.8.x"}`
- `/` → landing page → Continue with Google → lands on `/app` signed in
- Refresh `/app` → still signed in
- Sign out → back to `/`, and `/app` bounces you to `/`
- `GET /api/v1/auth/me` in a private window → 401
