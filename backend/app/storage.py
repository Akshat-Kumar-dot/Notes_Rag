"""Staging area for uploaded bytes.

Files live here only between upload and successful indexing. On Render's free
tier this is ephemeral disk, which is exactly right: nothing here is meant to
survive a restart except the small tail of failed and low-coverage files.
"""

from __future__ import annotations

import logging
from pathlib import Path
from uuid import UUID

log = logging.getLogger(__name__)

STAGING = Path("/tmp/note_rag_uploads")
STAGING.mkdir(parents=True, exist_ok=True)


def _path(file_id: UUID) -> Path:
    # Keyed by UUID, never by user-supplied filename: names collide and can
    # contain path traversal sequences.
    return STAGING / f"{file_id}.bin"


def stage(file_id: UUID, data: bytes) -> None:
    _path(file_id).write_bytes(data)


def load_staged(file_id: UUID) -> bytes:
    path = _path(file_id)
    if not path.exists():
        raise FileNotFoundError("The uploaded file is no longer available. Upload it again.")
    return path.read_bytes()


def discard(file_id: UUID) -> None:
    try:
        _path(file_id).unlink(missing_ok=True)
    except OSError:
        log.warning("could not delete staged file %s", file_id)
