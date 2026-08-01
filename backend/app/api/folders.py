from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.auth.deps import DB, CurrentUser
from app.models import File, Folder, User
from app.schemas import FolderCreate, FolderOut

router = APIRouter(prefix="/folders", tags=["folders"])


async def owned_folder(db: DB, user: User, folder_id: UUID) -> Folder:
    """The ownership check is part of the query, not a separate `if`. Fetch-then-
    check works until the day someone forgets it on the fourth endpoint."""
    folder = await db.scalar(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == user.id)
    )
    # 404 rather than 403: 403 would confirm the folder exists.
    if folder is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Folder not found.")
    return folder


@router.get("", response_model=list[FolderOut])
async def list_folders(user: CurrentUser, db: DB):
    rows = (
        await db.execute(
            select(
                Folder,
                func.count(File.id),
                func.coalesce(func.sum(File.size_bytes), 0),
            )
            .outerjoin(File, File.folder_id == Folder.id)
            .where(Folder.user_id == user.id)
            .group_by(Folder.id)
            .order_by(Folder.created_at)
        )
    ).all()
    return [
        FolderOut(
            id=f.id, name=f.name, created_at=f.created_at,
            file_count=n, size_bytes=int(size),
        )
        for f, n, size in rows
    ]


@router.post("", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
async def create_folder(payload: FolderCreate, user: CurrentUser, db: DB):
    folder = Folder(user_id=user.id, name=payload.name)
    db.add(folder)
    try:
        await db.flush()
    except IntegrityError:
        # Let the constraint decide -- a check-then-insert would race.
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "You already have a folder with that name."
        ) from None
    return FolderOut(id=folder.id, name=folder.name, created_at=folder.created_at, file_count=0)


@router.patch("/{folder_id}", response_model=FolderOut)
async def rename_folder(folder_id: UUID, payload: FolderCreate, user: CurrentUser, db: DB):
    folder = await owned_folder(db, user, folder_id)
    folder.name = payload.name
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "You already have a folder with that name."
        ) from None
    count, size = (
        await db.execute(
            select(func.count(File.id), func.coalesce(func.sum(File.size_bytes), 0))
            .where(File.folder_id == folder.id)
        )
    ).one()
    return FolderOut(id=folder.id, name=folder.name, created_at=folder.created_at,
                     file_count=count or 0, size_bytes=int(size or 0))


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(folder_id: UUID, user: CurrentUser, db: DB):
    folder = await owned_folder(db, user, folder_id)
    await db.delete(folder)
