"""Session lifecycle. Nothing here knows about Google -- swapping in guest login
later reuses this file untouched."""

from __future__ import annotations

import hashlib
import secrets
import time
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession as DBSession

from app.config import settings
from app.models import Session, User

COOKIE_NAME = "session"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---- verified-session cache ------------------------------------------------
# Every authenticated request used to spend a database round trip (plus the
# pool ping, BEGIN and COMMIT around it) just to check the cookie. Opening a
# chat, which is otherwise a ~5ms MongoDB read, took about a second. A session
# verified in the last ten minutes is trusted without asking again. (One minute
# was too short: reading an answer for a minute made the next click slow.)
#
# The trade-off: a session revoked by ANOTHER process stays usable for up to
# CACHE_TTL_S. This process evicts on logout and guest purge, and Render runs
# one process, so in practice revocation is immediate. Expiry is still checked
# on every request, against the cached expires_at.
CACHE_TTL_S = 600
_CACHE_MAX = 10_000
_cache: dict[str, tuple[float, datetime, User]] = {}   # token hash -> (cached at, expires, user)


def _snapshot(user: User) -> User:
    """A detached copy holding only column values: safe to share between
    requests, since it belongs to no session and nothing can lazy-load."""
    return User(**{c.key: getattr(user, c.key) for c in User.__table__.columns})


def _remember(token_hash: str, expires_at: datetime, user: User) -> None:
    if len(_cache) >= _CACHE_MAX:
        _cache.clear()   # crude, but bounded; entries are cheap to rebuild
    _cache[token_hash] = (time.monotonic(), expires_at, _snapshot(user))


def forget_user(user_id: UUID) -> None:
    """Drop every cached session of a user, e.g. a purged guest."""
    for key in [k for k, (_, _, u) in _cache.items() if u.id == user_id]:
        _cache.pop(key, None)


async def create_session(db: DBSession, user_id: UUID, ttl: timedelta | None = None) -> str:
    """Returns the raw token. It is never stored -- only its hash."""
    token = secrets.token_urlsafe(32)
    db.add(
        Session(
            user_id=user_id,
            token_hash=_hash(token),
            expires_at=datetime.now(UTC) + (ttl or timedelta(days=settings.session_ttl_days)),
        )
    )
    await db.flush()
    return token


async def resolve_session(db: DBSession, token: str) -> User | None:
    token_hash = _hash(token)
    hit = _cache.get(token_hash)
    if hit is not None:
        cached_at, expires_at, user = hit
        if time.monotonic() - cached_at < CACHE_TTL_S and expires_at > datetime.now(UTC):
            return user
        _cache.pop(token_hash, None)

    # Session and user in one query: a cache miss costs one round trip.
    found = (await db.execute(
        select(Session, User)
        .join(User, User.id == Session.user_id)
        .where(Session.token_hash == token_hash)
    )).first()
    if found is None:
        return None
    row, user = found

    if row.expires_at <= datetime.now(UTC):
        await db.delete(row)
        return None

    # Sliding expiry, but only written once a day. Updating on every request
    # would mean a database write per API call for no real benefit. Guest
    # sessions never slide: the trial ends when it ends.
    now = datetime.now(UTC)
    if user is not None and not user.is_guest and (now - row.last_seen_at).total_seconds() > 86_400:
        row.last_seen_at = now
        row.expires_at = now + timedelta(days=settings.session_ttl_days)

    _remember(token_hash, row.expires_at, user)
    return user


async def revoke_session(db: DBSession, token: str) -> None:
    _cache.pop(_hash(token), None)
    await db.execute(delete(Session).where(Session.token_hash == _hash(token)))


def set_session_cookie(response: Response, token: str, max_age: int | None = None) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=max_age or settings.session_ttl_days * 86_400,
        httponly=True,                  # unreadable from JavaScript
        secure=settings.is_prod,        # localhost is http, so only enforce in prod
        samesite="lax",                 # same-origin deployment; None is not needed
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")
