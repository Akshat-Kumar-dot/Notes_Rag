from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession as DBSession

from app.auth.session import COOKIE_NAME, resolve_session
from app.db import get_db
from app.models import User

DB = Annotated[DBSession, Depends(get_db)]


async def current_user(request: Request, response: Response, db: DB) -> User:
    """Fails closed: any missing, unknown or expired token is a 401.

    A session extended here re-sends its cookie on `response`, which FastAPI
    merges into the endpoint's reply -- unless the endpoint returns a Response
    object itself; see refresh_cookie."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue.")

    user = await resolve_session(db, token, response)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Your session has expired.")

    return user


CurrentUser = Annotated[User, Depends(current_user)]


def refresh_cookie(sub: Response, reply: Response) -> Response:
    """Copy a refreshed session cookie from the dependency `sub` response onto
    a Response the endpoint built itself, which FastAPI would otherwise send
    without it."""
    for key, value in sub.headers.raw:
        if key == b"set-cookie":
            reply.raw_headers.append((key, value))
    return reply
