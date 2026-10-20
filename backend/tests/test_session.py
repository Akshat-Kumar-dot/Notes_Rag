import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI, Response
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app.auth import session
from app.auth.deps import CurrentUser, refresh_cookie
from app.db import get_db
from app.models import Session, User

TOKEN = "t" * 43


class FakeDB:
    def __init__(self, row, user):
        self.found = (row, user)

    async def execute(self, _stmt):
        found = self.found

        class Result:
            def first(self):
                return found

        return Result()


def _db(last_seen_days_ago: float, is_guest: bool = False):
    now = datetime.now(UTC)
    user = User(id=uuid.uuid4(), is_guest=is_guest)
    row = Session(user_id=user.id, token_hash=session._hash(TOKEN),
                  last_seen_at=now - timedelta(days=last_seen_days_ago),
                  expires_at=now + timedelta(days=5))
    return FakeDB(row, user), row


@pytest.fixture(autouse=True)
def empty_cache():
    session._cache.clear()
    yield
    session._cache.clear()


def _client(db):
    app = FastAPI()

    async def override():
        yield db

    app.dependency_overrides[get_db] = override

    @app.get("/json")
    async def json_route(user: CurrentUser):
        return {"ok": True}

    @app.get("/stream")
    async def stream_route(user: CurrentUser, response: Response):
        async def body():
            yield b"data: hi\n\n"
        return refresh_cookie(response, StreamingResponse(body(), media_type="text/event-stream"))

    client = TestClient(app)
    client.cookies.set(session.COOKIE_NAME, TOKEN)
    return client


@pytest.mark.parametrize("path", ["/json", "/stream"])
def test_extended_session_resends_its_cookie(path):
    db, row = _db(last_seen_days_ago=2)
    resp = _client(db).get(path)
    assert resp.status_code == 200
    cookie = resp.headers.get("set-cookie", "")
    assert cookie.startswith(f"{session.COOKIE_NAME}={TOKEN}")
    assert "Max-Age=" in cookie
    assert row.expires_at > datetime.now(UTC) + timedelta(days=6)


@pytest.mark.parametrize("days, is_guest", [(0.1, False), (2, True)])
def test_no_cookie_when_the_session_is_not_extended(days, is_guest):
    db, row = _db(last_seen_days_ago=days, is_guest=is_guest)
    before = row.expires_at
    resp = _client(db).get("/json")
    assert resp.status_code == 200
    assert "set-cookie" not in resp.headers
    assert row.expires_at == before


def test_no_extension_without_a_response_to_carry_the_cookie():
    db, row = _db(last_seen_days_ago=2)
    before = row.expires_at
    assert asyncio.run(session.resolve_session(db, TOKEN)) is not None
    assert row.expires_at == before
