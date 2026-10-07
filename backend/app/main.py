from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.datastructures import MutableHeaders
from starlette.middleware.sessions import SessionMiddleware

from app import mongo
from app.api import chat, files, folders, search, study
from app.auth import google, guest
from app.config import settings
from app.db import engine

logging.basicConfig(level="INFO", format="%(asctime)s %(levelname)-7s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await mongo.ensure_indexes()
    try:
        await guest.purge_expired_guests()
    except Exception:
        logging.getLogger(__name__).exception("guest purge failed on startup")
    yield
    await mongo.client.close()


app = FastAPI(
    title="Note_Rag",
    docs_url=None if settings.is_prod else "/docs",
    lifespan=lifespan,
)

class CacheHeaders:
    """Pages must be revalidated on every load; without a Cache-Control header
    browsers cache them heuristically and keep showing the previous build after
    a deploy. The JS/CSS they point to have content-hashed names, so those can
    be cached forever. Pure ASGI (not BaseHTTPMiddleware) so SSE streams from
    the API pass through untouched -- the API is skipped entirely anyway."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or path.startswith(settings.api_prefix):
            await self.app(scope, receive, send)
            return

        async def send_with_cache(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if path.startswith("/_next/static/"):
                    headers["Cache-Control"] = "public, max-age=31536000, immutable"
                elif headers.get("content-type", "").startswith("text/html"):
                    headers["Cache-Control"] = "no-cache"
            await send(message)

        await self.app(scope, receive, send_with_cache)


app.add_middleware(CacheHeaders)

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
    try:
        mongo_ok = (await mongo.client.admin.command("ping")).get("ok") == 1.0
    except Exception:
        mongo_ok = False
    return JSONResponse(
        {
            "ok": True,
            "env": settings.env,
            "pgvector": pgvector,
            "mongodb": mongo_ok,
            "gemini_configured": bool(settings.gemini_api_key),
        }
    )


# Routers BEFORE the static mount. Mounting "/" first swallows every API route
# and returns HTML from /api/v1/auth/me.
for r in (google.router, guest.router, folders.router, files.router, search.router, chat.router,
          study.router):
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
