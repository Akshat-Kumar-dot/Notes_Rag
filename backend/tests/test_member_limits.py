import asyncio
import uuid
from collections import Counter
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.auth import guest
from app.models import DailyUsage


@pytest.fixture
def counts(monkeypatch):
    """Stands in for daily_usage: same rule as _bump_daily's upsert, which
    only counts while count < cap."""
    seen: Counter = Counter()

    async def bump(_db, kind, cap):
        if cap <= 0 or seen[kind] >= cap:
            return False
        seen[kind] += 1
        return True

    monkeypatch.setattr(guest, "_bump_daily", bump)
    monkeypatch.setattr(guest.settings, "member_messages_per_day", 3)
    monkeypatch.setattr(guest.settings, "member_uploads_per_day", 2)
    monkeypatch.setattr(guest.settings, "member_daily_messages", 5)
    monkeypatch.setattr(guest.settings, "member_daily_uploads", 100)
    return seen


def member():
    return SimpleNamespace(id=uuid.uuid4(), is_guest=False)


def spend(user, kind):
    asyncio.run(guest.spend(None, user, kind))


def test_signed_in_user_is_capped_per_day(counts):
    alice = member()
    for _ in range(3):
        spend(alice, "message")
    with pytest.raises(HTTPException) as exc:
        spend(alice, "message")
    assert exc.value.status_code == 429
    assert "3 questions" in exc.value.detail


def test_uploads_and_messages_are_counted_separately(counts):
    alice = member()
    spend(alice, "upload")
    spend(alice, "upload")
    with pytest.raises(HTTPException) as exc:
        spend(alice, "upload")
    assert exc.value.status_code == 429 and "2 uploads" in exc.value.detail
    spend(alice, "message")   # still has questions left


def test_each_user_has_their_own_count(counts):
    alice, bob = member(), member()
    for _ in range(3):
        spend(alice, "message")
    spend(bob, "message")


def test_site_wide_ceiling_stops_everyone(counts):
    users = [member() for _ in range(5)]
    for u in users:
        spend(u, "message")
    with pytest.raises(HTTPException) as exc:
        spend(member(), "message")
    assert exc.value.status_code == 503


def test_counter_key_fits_the_column_and_is_unique():
    width = DailyUsage.__table__.c.kind.type.length
    ids = [uuid.uuid4() for _ in range(1000)]
    keys = {guest.member_counter(i, "message") for i in ids}
    assert len(keys) == len(ids)
    assert max(len(k) for k in keys) <= width
    assert guest.member_counter(ids[0], "upload") != guest.member_counter(ids[0], "message")
