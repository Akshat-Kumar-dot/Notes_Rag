"""Session lifecycle. Nothing here knows about Google -- swapping in guest login
later reuses this file untouched."""

from __future__ import annotations

import hashlib
import secrets
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


async def create_session(db: DBSession, user_id: UUID) -> str:
    """Returns the raw token. It is never stored -- only its hash."""
    token = secrets.token_urlsafe(32)
    db.add(
        Session(
            user_id=user_id,
            token_hash=_hash(token),
            expires_at=datetime.now(UTC) + timedelta(days=settings.session_ttl_days),
        )
    )
    await db.flush()
    return token


async def resolve_session(db: DBSession, token: str) -> User | None:
    row = await db.scalar(select(Session).where(Session.token_hash == _hash(token)))
    if row is None:
        return None

    if row.expires_at <= datetime.now(UTC):
        await db.delete(row)
        return None

    # Sliding expiry, but only written once a day. Updating on every request
    # would mean a database write per API call for no real benefit.
    now = datetime.now(UTC)
    if (now - row.last_seen_at).total_seconds() > 86_400:
        row.last_seen_at = now
        row.expires_at = now + timedelta(days=settings.session_ttl_days)

    return await db.get(User, row.user_id)


async def revoke_session(db: DBSession, token: str) -> None:
    await db.execute(delete(Session).where(Session.token_hash == _hash(token)))


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.session_ttl_days * 86_400,
        httponly=True,                  # unreadable from JavaScript
        secure=settings.is_prod,        # localhost is http, so only enforce in prod
        samesite="lax",                 # same-origin deployment; None is not needed
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")
