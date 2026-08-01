from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.middleware.sessions import SessionMiddleware

from app.auth import google
from app.config import settings
from app.db import engine

logging.basicConfig(level="INFO", format="%(asctime)s %(levelname)-7s %(name)s %(message)s")

app = FastAPI(title="notes-rag", docs_url=None if settings.is_prod else "/docs")

# Used only to carry the OAuth `state` value between /login and /callback.
# Short-lived and unrelated to the login session.
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
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
    return JSONResponse({"ok": True, "env": settings.env, "pgvector": pgvector})


# ---------------------------------------------------------------------------
# Routers BEFORE the static mount. Mounting "/" first would swallow every API
# route and return HTML from /api/v1/auth/me.
# ---------------------------------------------------------------------------
app.include_router(google.router, prefix=settings.api_prefix)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIR.is_dir():
    # html=True resolves /app to app.html, which is what `next build` with
    # output:"export" produces.
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
else:
    logging.getLogger(__name__).warning(
        "no static/ directory - frontend not built; API-only mode"
    )
