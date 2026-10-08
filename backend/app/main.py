from __future__ import annotations

import logging
import hashlib
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.sessions import SessionMiddleware

from app import mongo
from app.api import chat, files, folders, search, study
from app.auth import google, guest
from app.auth.guest import from_cloudflare
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

BUILD_COOKIE = "build"


def _build_id() -> str | None:
    """Fingerprint of the frontend being served: changes on every deploy, and
    locally whenever the static files are rebuilt (no restart needed)."""
    pages = (STATIC_DIR / "index.html", STATIC_DIR / "app.html")
    try:
        stamp = tuple((p.stat().st_mtime_ns, p.stat().st_size) for p in pages)
    except OSError:
        return None
    return _hash_pages(stamp)


@lru_cache(maxsize=4)
def _hash_pages(stamp: tuple) -> str:
    pages = (STATIC_DIR / "index.html", STATIC_DIR / "app.html")
    return hashlib.sha256(b"".join(p.read_bytes() for p in pages)).hexdigest()[:12]


def _cookie(scope, name: str) -> str | None:
    for key, value in scope.get("headers", []):
        if key == b"cookie":
            for part in value.decode("latin-1").split(";"):
                k, _, v = part.strip().partition("=")
                if k == name:
                    return v
    return None


class CacheHeaders:
    """Keeps browsers on the current build.

    Pages must be revalidated on every load; without a Cache-Control header
    browsers cache them heuristically and keep showing the previous build after
    a deploy. The JS/CSS they point to have content-hashed names, so those can
    be cached forever.

    Pages cached BEFORE that header existed are still out there, and a browser
    serves them without asking the server -- which is why an old UI could
    reappear "out of nowhere". Those stale pages still call the API, though, and
    API calls always reach the server. So when a request comes from a browser
    that hasn't loaded this build, the reply carries Clear-Site-Data: "cache",
    which empties its HTTP cache: its next page load is the current build. A
    `build` cookie marks browsers already up to date, so this happens once per
    deploy, not on every request.

    Pure ASGI (not BaseHTTPMiddleware) so SSE streams pass through untouched.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        is_api = path.startswith(settings.api_prefix)
        build = _build_id()
        # Through Cloudflare, pages come from Cloudflare Pages, which always
        # revalidates HTML -- and its build differs from the copy baked in
        # here, so comparing the two would clear caches for no reason.
        proxied = from_cloudflare(Headers(scope=scope))
        stale = (not proxied and build is not None
                 and _cookie(scope, BUILD_COOKIE) != build)

        async def send_with_cache(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                is_page = headers.get("content-type", "").startswith("text/html")
                if path.startswith("/_next/static/"):
                    headers["Cache-Control"] = "public, max-age=31536000, immutable"
                elif is_page:
                    headers["Cache-Control"] = "no-cache"
                if stale and (is_api or is_page):
                    if is_api:
                        # Only API replies: a page reply is fresh by definition.
                        headers.append("Clear-Site-Data", '"cache"')
                    headers.append(
                        "Set-Cookie",
                        f"{BUILD_COOKIE}={build}; Path=/; Max-Age=31536000; SameSite=Lax"
                        + ("; Secure" if settings.is_prod else ""),
                    )
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
