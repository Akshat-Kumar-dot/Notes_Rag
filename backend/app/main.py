from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.middleware.sessions import SessionMiddleware

from app.api import chat, files, folders, search
from app.auth import google
from app.config import settings
from app.db import engine

logging.basicConfig(level="INFO", format="%(asctime)s %(levelname)-7s %(name)s %(message)s")

app = FastAPI(title="Note_Rag", docs_url=None if settings.is_prod else "/docs")

# Carries the OAuth `state` value between /login and /callback only. Unrelated
# to the login session, which lives in Postgres.
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    # MUST differ from auth.session.COOKIE_NAME. Starlette defaults this to
    # "session"; sharing the name means the login cookie and the OAuth state
    # cookie overwrite each other, producing intermittent
    # "mismatching_state: CSRF Warning" failures.
    session_cookie="oauth_state",
    max_age=600,
    same_site="lax",
    https_only=settings.is_prod,
)


@app.get(f"{settings.api_prefix}/health")
async def health() -> JSONResponse:
    async with engine.connect() as conn:
        pgvector = await conn.scalar(
            text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        )
    return JSONResponse(
        {
            "ok": True,
            "env": settings.env,
            "pgvector": pgvector,
            "gemini_configured": bool(settings.gemini_api_key),
        }
    )


# Routers BEFORE the static mount. Mounting "/" first swallows every API route
# and returns HTML from /api/v1/auth/me.
for r in (google.router, folders.router, files.router, search.router, chat.router):
    app.include_router(r, prefix=settings.api_prefix)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

if STATIC_DIR.is_dir():
    from fastapi.responses import FileResponse, HTMLResponse

    # `next build` with output:"export" emits out/app.html, but StaticFiles
    # only resolves /app when app/ is a directory holding index.html. Serve the
    # exported .html files explicitly instead of relying on that.
    @app.get("/{page}", include_in_schema=False)
    async def _page(page: str):
        # A real top-level file (favicon.ico, robots.txt) wins.
        direct = STATIC_DIR / page
        if direct.is_file():
            return FileResponse(direct)
        exported = STATIC_DIR / f"{page}.html"
        if exported.is_file():
            return FileResponse(exported)
        return HTMLResponse("Not found", status_code=404)

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
else:
    logging.getLogger(__name__).warning("no static/ directory - API-only mode")
