from __future__ import annotations

import hashlib
from pathlib import PurePosixPath
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, status
from sqlalchemy import select

from app.api.folders import owned_folder
from app.auth.deps import DB, CurrentUser
from app.config import settings
from app.ingest import process_file
from app.models import File, FileStatus
from app.parsers.base import EXTENSION_MIME
from app.parsers import SUPPORTED_MIMES
from app.schemas import FileOut
from app.storage import discard, stage

router = APIRouter(tags=["files"])


def _detect_mime(upload: UploadFile) -> str:
    """Trust the extension over the browser's Content-Type: browsers send
    application/octet-stream for anything they don't recognise."""
    suffix = PurePosixPath(upload.filename or "").suffix.lower()
    if mime := EXTENSION_MIME.get(suffix):
        return mime
    if upload.content_type in SUPPORTED_MIMES:
        return upload.content_type
    raise HTTPException(
        status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        "Supported files: PDF, Word (.docx), text, Markdown, and images.",
    )


@router.post(
    "/folders/{folder_id}/files",
    response_model=FileOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def upload(
    folder_id: UUID,
    upload: UploadFile,
    background: BackgroundTasks,
    user: CurrentUser,
    db: DB,
):
    folder = await owned_folder(db, user, folder_id)
    mime = _detect_mime(upload)

    data = await upload.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty.")
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Files must be under {settings.max_upload_mb}MB.",
        )

    digest = hashlib.sha256(data).hexdigest()
    existing = await db.scalar(
        select(File).where(File.user_id == user.id, File.sha256 == digest)
    )
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"You've already uploaded this file as '{existing.original_filename}'.",
        )

    file = File(
        folder_id=folder.id,
        user_id=user.id,
        original_filename=(upload.filename or "untitled")[:400],
        mime_type=mime,
        size_bytes=len(data),
        sha256=digest,
        status=FileStatus.PENDING,
    )
    db.add(file)
    await db.flush()
    stage(file.id, data)
    # Commit BEFORE scheduling: background tasks can start before the request
    # dependency's teardown commits, and the worker would then find no row and
    # silently do nothing, leaving the file stuck on "pending" forever.
    await db.commit()

    # 202: parsing a large PDF takes far longer than a request should live.
    # The client polls GET /files/{id} for status.
    background.add_task(process_file, file.id)
    return FileOut.model_validate(file)


@router.get("/folders/{folder_id}/files", response_model=list[FileOut])
async def list_files(folder_id: UUID, user: CurrentUser, db: DB):
    await owned_folder(db, user, folder_id)
    rows = await db.scalars(
        select(File).where(File.folder_id == folder_id).order_by(File.created_at.desc())
    )
    return list(rows)


@router.get("/files/{file_id}", response_model=FileOut)
async def get_file(file_id: UUID, user: CurrentUser, db: DB):
    file = await db.scalar(
        select(File).where(File.id == file_id, File.user_id == user.id)
    )
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    return file


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(file_id: UUID, user: CurrentUser, db: DB):
    file = await db.scalar(
        select(File).where(File.id == file_id, File.user_id == user.id)
    )
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    await db.delete(file)
    discard(file_id)
