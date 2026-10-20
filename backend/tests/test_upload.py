import asyncio
import hashlib
import io
import uuid
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile

from app.api import files
from app.models import File, FileStatus

DATA = b"# Notes\n\nSome text worth indexing."


class FakeDB:
    """Answers upload's two queries: the duplicate lookup, then bytes used."""

    def __init__(self, existing, used):
        self.answers = [existing, used]
        self.ops = []

    async def scalar(self, _stmt):
        return self.answers.pop(0)

    async def delete(self, obj):
        self.ops.append(("delete", obj))

    async def flush(self):
        self.ops.append(("flush", None))

    def add(self, obj):
        self.ops.append(("add", obj))

    async def commit(self):
        self.ops.append(("commit", None))


@pytest.fixture
def user(monkeypatch):
    folder = SimpleNamespace(id=uuid.uuid4())

    async def owned_folder(*_):
        return folder

    async def spend(*_):
        pass

    monkeypatch.setattr(files, "owned_folder", owned_folder)
    monkeypatch.setattr(files.guest, "spend", spend)
    monkeypatch.setattr(files, "stage", lambda *_: None)
    monkeypatch.setattr(files, "discard", lambda *_: None)
    monkeypatch.setattr(files.FileOut, "model_validate", staticmethod(lambda f: f))
    return SimpleNamespace(id=uuid.uuid4(), is_guest=False)


def _existing(user, status, size):
    return File(id=uuid.uuid4(), user_id=user.id, original_filename="notes.md",
                sha256=hashlib.sha256(DATA).hexdigest(), size_bytes=size, status=status)


def _upload(user, db):
    upload = UploadFile(io.BytesIO(DATA), filename="notes.md")
    return asyncio.run(files.upload(uuid.uuid4(), upload, BackgroundTasks(), user, db))


def test_reupload_replaces_a_failed_copy(user, monkeypatch):
    # Quota is full with the failed copy counted: it must not block its own retry.
    monkeypatch.setattr(files.settings, "storage_limit_mb", 1)
    old = _existing(user, FileStatus.FAILED, 1024 * 1024)
    db = FakeDB(old, 1024 * 1024)

    new = _upload(user, db)

    kinds = [k for k, _ in db.ops]
    assert kinds[:3] == ["delete", "flush", "add"]
    assert db.ops[0][1] is old and new is not old


@pytest.mark.parametrize("status", [FileStatus.INDEXED, FileStatus.PARTIAL, FileStatus.PENDING])
def test_reupload_of_a_live_copy_is_refused(user, status):
    db = FakeDB(_existing(user, status, len(DATA)), len(DATA))
    with pytest.raises(HTTPException) as exc:
        _upload(user, db)
    assert exc.value.status_code == 409
    assert db.ops == []
