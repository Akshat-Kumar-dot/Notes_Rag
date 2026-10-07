"""Google OAuth 2.0 authorization-code flow.

Authlib handles the state parameter, the code exchange, and id_token signature
verification against Google's JWKS -- the three things that are easy to get
subtly wrong by hand.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.auth.deps import DB, CurrentUser
from app.auth.guest import user_out
from app.auth.session import (
    COOKIE_NAME,
    clear_session_cookie,
    create_session,
    revoke_session,
    set_session_cookie,
)
from app.config import settings
from app.models import User
from app.schemas import UserOut

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

oauth = OAuth()
oauth.register(
    name="google",
    client_id=settings.google_client_id,
    client_secret=settings.google_client_secret,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


@router.get("/google/login")
async def google_login(request: Request):
    return await oauth.google.authorize_redirect(request, settings.redirect_uri)


@router.get("/google/callback")
async def google_callback(request: Request, db: DB):
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError as exc:
        log.warning("oauth callback failed: %s", exc)
        return RedirectResponse("/?error=signin_failed", status_code=303)

    claims = token.get("userinfo") or {}
    sub = claims.get("sub")
    if not sub:
        return RedirectResponse("/?error=signin_failed", status_code=303)

    user = await db.scalar(select(User).where(User.google_sub == sub))
    if user is None:
        user = User(google_sub=sub)
        db.add(user)

    # Refresh profile on every login; people change their name and photo.
    user.email = claims.get("email")
    user.display_name = claims.get("name")
    user.avatar_url = claims.get("picture")
    user.last_login_at = datetime.now(UTC)
    await db.flush()

    session_token = await create_session(db, user.id)
    await db.commit()

    response = RedirectResponse("/app", status_code=303)
    set_session_cookie(response, session_token)
    return response


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser, db: DB) -> UserOut:
    return await user_out(db, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, db: DB):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        await revoke_session(db, token)
    out = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookie(out)
    return out
