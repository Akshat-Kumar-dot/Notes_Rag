"""Free trial without signing in: one document and two questions.

No single signal identifies an anonymous visitor. IPs are shared (a campus
behind one NAT) and changeable (VPNs, mobile data), and a browser fingerprint
is computed client-side, so it can be forged. So the defence is layered,
weakest to strongest:

  1. device cookie + fingerprint-on-this-IP -- stops "just open incognito"
  2. trials per IP per day                  -- slows scripted signups
  3. credits per guest                      -- exact: one atomic UPDATE each
  4. site-wide daily caps                   -- the real ceiling on the Gemini
                                               bill, whatever 1 and 2 miss

IPs, fingerprints and device ids are stored only as HMAC hashes.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status
from sqlalchemy import and_, delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import chat_store, study_store
from app.auth.deps import DB
from app.auth.session import (
    COOKIE_NAME, create_session, forget_user, resolve_session, set_session_cookie,
)
from app.config import settings
from app.db import SessionLocal
from app.models import DailyUsage, File, Folder, GuestTrial, User
from app.schemas import GuestCredits, GuestStart, UserOut
from app.storage import discard

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

DEVICE_COOKIE = "device"
DEVICE_COOKIE_DAYS = 400   # browsers cap cookie lifetime at 400 days

Kind = Literal["upload", "message"]

_OUT_OF_CREDITS = {
    "upload": "Your free trial includes one document. Sign in with Google to upload more.",
    "message": "You've used your free questions. Sign in with Google to keep asking.",
}
_BUSY = "Free trials are at capacity for today. Sign in with Google to keep going."


# ------------------------------------------------------------- identifying


def client_ip(request: Request) -> str:
    """The caller's IP, without trusting anything the caller can forge.

    Each trusted proxy appends the address it received the request from to
    X-Forwarded-For. Entries to the left of those are whatever the client sent,
    so read exactly `trusted_proxy_hops` entries from the right -- never the
    leftmost, which anyone can set with one header."""
    peer = request.client.host if request.client else "0.0.0.0"
    hops = settings.trusted_proxy_hops
    if hops <= 0:
        return peer
    chain = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    if len(chain) < hops:
        return peer
    candidate = chain[-hops]
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return peer
    return candidate


def network_key(ip: str) -> str:
    """IPv4: the address. IPv6: its /64 -- a host can pick fresh addresses
    inside its /64 at will (privacy extensions), so the /64 is the subscriber."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6:
        if addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


def _hash(kind: str, value: str) -> str:
    """Keyed, so the stored hashes cannot be reversed by hashing all 4 billion
    IPv4 addresses -- which a plain SHA-256 of an IP would allow."""
    return hmac.new(
        settings.secret_key.encode(), f"{kind}:{value}".encode(), hashlib.sha256
    ).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


# ----------------------------------------------------------------- credits


async def _bump_daily(db: AsyncSession, kind: str, cap: int) -> bool:
    """Count one more `kind` for today, atomically, unless the cap is reached.
    INSERT ... ON CONFLICT DO UPDATE ... WHERE count < cap: two concurrent
    requests can never both take the last slot."""
    if cap <= 0:
        return False
    stmt = (
        pg_insert(DailyUsage)
        .values(day=_now().date(), kind=kind, count=1)
        .on_conflict_do_update(
            index_elements=["day", "kind"],
            set_={"count": DailyUsage.count + 1},
            where=DailyUsage.count < cap,
        )
        .returning(DailyUsage.count)
    )
    return (await db.execute(stmt)).first() is not None


def _credit(kind: Kind):
    if kind == "upload":
        return GuestTrial.uploads_used, settings.guest_uploads, settings.guest_daily_uploads
    return GuestTrial.messages_used, settings.guest_messages, settings.guest_daily_messages


async def spend(db: AsyncSession, user: User, kind: Kind) -> None:
    """Take one guest credit, or raise. No-op for signed-in users.

    Runs in the caller's transaction: if the request fails afterwards and rolls
    back, the credit comes back with it. The WHERE used < cap makes the check
    and the increment one statement, so parallel requests cannot overspend."""
    if not user.is_guest:
        return
    used, cap, daily_cap = _credit(kind)
    took = await db.execute(
        update(GuestTrial)
        .where(GuestTrial.user_id == user.id, used < cap)
        .values({used: used + 1})
        .returning(GuestTrial.id)
    )
    if took.first() is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, _OUT_OF_CREDITS[kind])
    if not await _bump_daily(db, f"guest_{kind}", daily_cap):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, _BUSY)


async def refund(user_id: UUID, kind: Kind) -> None:
    """Give a guest their credit back after a failure that was not their doing
    (an unreadable file, Gemini erroring mid-answer). Its own session: callers
    are past the point where the request transaction exists.

    The site-wide daily counter is deliberately NOT decremented. It counts
    attempts, and attempts are what cost money -- otherwise a guest who could
    provoke failures would get unlimited retries past the daily cap."""
    used, _, _ = _credit(kind)
    async with SessionLocal() as db:
        await db.execute(
            update(GuestTrial)
            .where(GuestTrial.user_id == user_id, used > 0)
            .values({used: used - 1})
        )
        await db.commit()


async def user_out(db: AsyncSession, user: User) -> UserOut:
    out = UserOut.model_validate(user)
    if user.is_guest:
        trial = await db.scalar(select(GuestTrial).where(GuestTrial.user_id == user.id))
        if trial is not None:
            out.guest = GuestCredits(
                uploads_left=max(0, settings.guest_uploads - trial.uploads_used),
                messages_left=max(0, settings.guest_messages - trial.messages_used),
                expires_at=trial.created_at + timedelta(hours=settings.guest_ttl_hours),
            )
    return out


# ---------------------------------------------------------------- cleanup


async def purge_expired_guests(limit: int = 50) -> int:
    """Delete guests past their TTL, with everything they uploaded. Postgres
    cascades folders, files, chunks and sessions; guest_trials.user_id goes
    NULL so the abuse history survives. MongoDB and the staging dir have no
    foreign keys, so they are cleaned here by hand."""
    async with SessionLocal() as db:
        ids = list(await db.scalars(
            select(User.id)
            .where(User.is_guest, User.created_at < _now() - timedelta(hours=settings.guest_ttl_hours))
            .limit(limit)
        ))
        # Trial records only need to live as long as the device window.
        await db.execute(
            delete(GuestTrial).where(
                GuestTrial.user_id.is_(None),
                GuestTrial.created_at < _now() - timedelta(days=settings.guest_device_window_days),
            )
        )
        file_ids = list(await db.scalars(select(File.id).where(File.user_id.in_(ids)))) if ids else []
        if ids:
            await db.execute(delete(User).where(User.id.in_(ids)))
        await db.commit()

    for file_id in file_ids:
        discard(file_id)
    for user_id in ids:
        forget_user(user_id)
        await chat_store.delete_user_conversations(user_id)
        await study_store.forget_user(user_id)
    if ids:
        log.info("purged %d expired guest accounts", len(ids))
    return len(ids)


PURGE_EVERY_S = 600
_last_purge = 0.0


async def _purge_in_background() -> None:
    """Runs after the response is sent, at most every ten minutes per process:
    cleanup is housekeeping, and a visitor should never wait for it."""
    global _last_purge
    if time.monotonic() - _last_purge < PURGE_EVERY_S:
        return
    _last_purge = time.monotonic()
    try:
        await purge_expired_guests()
    except Exception:
        log.exception("guest purge failed")


# ---------------------------------------------------------------- endpoint


@router.post("/guest", response_model=UserOut)
async def start_guest(
    payload: GuestStart, request: Request, response: Response,
    background: BackgroundTasks, db: DB,
):
    """Every statement here is a round trip to Neon, so the path is kept to
    the minimum: lock, one combined check, the daily cap, the inserts."""
    # Already signed in (as a guest or with Google): nothing to start.
    token = request.cookies.get(COOKIE_NAME)
    if token and (existing := await resolve_session(db, token)) is not None:
        return await user_out(db, existing)

    background.add_task(_purge_in_background)

    raw_ip = client_ip(request)
    ip = network_key(raw_ip)
    try:
        # Local dev: every visitor is 127.0.0.1, so a per-network cap would
        # only ever lock out the developer. Never true behind a real proxy.
        loopback = ipaddress.ip_address(raw_ip).is_loopback
    except ValueError:
        loopback = False
    if settings.trusted_proxy_hops:
        # Check this once after deploying: `resolved` must be your own public
        # IP. If it is a proxy's, adjust TRUSTED_PROXY_HOPS.
        log.info("guest start: x-forwarded-for=%r resolved=%s",
                 request.headers.get("x-forwarded-for"), ip)

    device = request.cookies.get(DEVICE_COOKIE) or ""
    if not (16 <= len(device) <= 64):
        device = secrets.token_urlsafe(24)
    ip_h, device_h = _hash("ip", ip), _hash("device", device)
    fp_h = _hash("fp", payload.fingerprint)

    # Serialise trial creation per network until commit, so ten parallel
    # requests from one machine cannot all pass the checks below.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": ip_h})

    now = _now()
    # Both checks in one query: FILTER counts each condition separately over
    # the rows that match this device or this network.
    reused, from_ip = (await db.execute(
        select(
            func.count().filter(
                GuestTrial.created_at > now - timedelta(days=settings.guest_device_window_days),
                or_(
                    GuestTrial.device_hash == device_h,
                    # Fingerprints collide across identical phones, so on its
                    # own it would lock out strangers. Together with the same
                    # network it catches incognito and cleared cookies.
                    and_(GuestTrial.fingerprint_hash == fp_h, GuestTrial.ip_hash == ip_h),
                ),
            ),
            func.count().filter(
                GuestTrial.ip_hash == ip_h, GuestTrial.created_at > now - timedelta(days=1)
            ),
        ).where(or_(GuestTrial.device_hash == device_h, GuestTrial.ip_hash == ip_h))
    )).one()
    if reused:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This device has already used its free trial. Sign in with Google to keep going.",
        )

    if from_ip >= settings.guest_trials_per_ip_per_day and not loopback:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many free trials from this network today. Sign in with Google, or try tomorrow.",
        )

    if not await _bump_daily(db, "guest_trial", settings.guest_daily_trials):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, _BUSY)

    user_id = uuid.uuid4()
    db.add(User(id=user_id, is_guest=True, display_name="Guest", created_at=now, last_login_at=now))
    # Flushed on its own: with no relationship() between these models, the
    # unit of work does not promise to insert users before the rows that
    # reference it. Same statement count either way.
    await db.flush()
    db.add(GuestTrial(user_id=user_id, ip_hash=ip_h, device_hash=device_h,
                      fingerprint_hash=fp_h, created_at=now))
    # Ready to upload into straight away; guests get exactly this one folder.
    db.add(Folder(user_id=user_id, name="Trial"))
    ttl = timedelta(hours=settings.guest_ttl_hours)
    session_token = await create_session(db, user_id, ttl)
    await db.commit()

    set_session_cookie(response, session_token, max_age=int(ttl.total_seconds()))
    response.set_cookie(
        DEVICE_COOKIE, device,
        max_age=DEVICE_COOKIE_DAYS * 86_400,
        httponly=True, secure=settings.is_prod, samesite="lax", path="/",
    )
    # Built directly: a fresh trial has every credit, so re-reading the row
    # would only add a round trip.
    return UserOut(
        id=user_id, email=None, display_name="Guest", avatar_url=None, is_guest=True,
        guest=GuestCredits(
            uploads_left=settings.guest_uploads, messages_left=settings.guest_messages,
            expires_at=now + ttl,
        ),
    )
