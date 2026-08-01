from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession as DBSession

from app.auth.session import COOKIE_NAME, resolve_session
from app.db import get_db
from app.models import User

DB = Annotated[DBSession, Depends(get_db)]


async def current_user(request: Request, db: DB) -> User:
    """Fails closed: any missing, unknown or expired token is a 401."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue.")

    user = await resolve_session(db, token)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Your session has expired.")

    return user


CurrentUser = Annotated[User, Depends(current_user)]
