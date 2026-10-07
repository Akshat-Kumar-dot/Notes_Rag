"""Pipeline orchestrator: parse -> chunk -> embed -> store -> discard original.

Takes ids only, no FastAPI types. Today it runs in a BackgroundTask; moving it
to a real worker later needs no changes here.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select

from app.auth.guest import refund
from app.config import settings
from app.db import SessionLocal
from app.models import Chunk, File, FileStatus, FileText, User
from app.parsers import ParseError, parser_for
from app.rag.chunking import chunk_pages
from app.rag.embeddings import EmbeddingError, embed_documents
from app.storage import discard, load_staged

log = logging.getLogger(__name__)


async def process_file(file_id: UUID) -> None:
    async with SessionLocal() as db:
        file = await db.get(File, file_id)
        if file is None:
            return
        is_guest = bool(await db.scalar(select(User.is_guest).where(User.id == file.user_id)))
        file.status = FileStatus.PARSING
        await db.commit()

    try:
        data = load_staged(file_id)
        result = parser_for(file.mime_type)(data)

        pieces = chunk_pages(
            result.pages,
            size=settings.chunk_tokens,
            overlap=settings.chunk_overlap_tokens,
        )
        if not pieces:
            raise ParseError("Nothing indexable was found in this file.")
        # Embedding is the expensive step, so a guest's one document is capped
        # by chunks rather than bytes: a 5MB text file can hold 1,000+ pages.
        truncated = is_guest and len(pieces) > settings.guest_max_chunks
        if truncated:
            pieces = pieces[: settings.guest_max_chunks]

        vectors = await embed_documents([p.text for p in pieces])

        async with SessionLocal() as db:
            file = await db.get(File, file_id)
            if file is None:
                return

            db.add(FileText(file_id=file.id, text=result.text))
            for piece, vec in zip(pieces, vectors, strict=True):
                db.add(
                    Chunk(
                        file_id=file.id,
                        folder_id=file.folder_id,
                        user_id=file.user_id,
                        ordinal=piece.ordinal,
                        page_number=piece.page_number,
                        heading=piece.heading,
                        text=piece.text,
                        token_count=piece.token_count,
                        embedding=vec,
                    )
                )

            coverage = result.coverage
            file.page_count = result.page_count
            file.pages_with_text = result.pages_with_text
            file.chars_extracted = result.chars
            file.coverage = coverage
            file.parser_name = result.parser_name
            file.parser_version = result.parser_version
            file.chunk_count = len(pieces)
            file.indexed_at = datetime.now(UTC)
            if truncated:
                # Shown under the file, so the guest knows why later pages
                # never come up in answers.
                file.error = (
                    f"Free trial: only the first {len(pieces)} sections were indexed. "
                    "Sign in with Google to index whole documents."
                )
            file.status = (
                FileStatus.PARTIAL if coverage < settings.keep_original_below_coverage
                else FileStatus.INDEXED
            )
            # Keep the original only when extraction was poor -- those are the
            # files worth OCRing later, and OCR needs the pixels.
            file.original_retained = file.status == FileStatus.PARTIAL
            await db.commit()

            if not file.original_retained:
                discard(file_id)

        log.info("indexed %s: %s chunks, coverage %.2f", file_id, len(pieces), coverage)

    except (ParseError, EmbeddingError) as exc:
        await _fail(file_id, str(exc))
        await _refund_guest(file.user_id, is_guest)
    except Exception:
        log.exception("ingest failed for %s", file_id)
        await _fail(file_id, "Something went wrong processing this file.")
        await _refund_guest(file.user_id, is_guest)


async def _refund_guest(user_id: UUID, is_guest: bool) -> None:
    """An unreadable file should not cost a guest their only upload."""
    if is_guest:
        await refund(user_id, "upload")


async def _fail(file_id: UUID, message: str) -> None:
    async with SessionLocal() as db:
        file = await db.get(File, file_id)
        if file:
            file.status = FileStatus.FAILED
            file.error = message[:1000]
            # Original is kept on failure so a retry doesn't need a re-upload.
            file.original_retained = True
            await db.commit()
