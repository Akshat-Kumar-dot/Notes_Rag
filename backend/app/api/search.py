"""Retrieval only. No model, no rate limit, no hallucination surface -- every
word returned is something the user uploaded."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Query

from app.auth.deps import DB, CurrentUser
from app.rag.retrieval import retrieve
from app.schemas import SearchHit, SearchResponse

router = APIRouter(tags=["search"])


@router.get("/search", response_model=SearchResponse)
async def search(
    user: CurrentUser,
    db: DB,
    q: str = Query(min_length=1, max_length=500),
    folder_ids: list[UUID] = Query(default=[]),
    limit: int = Query(default=10, ge=1, le=30),
):
    result = await retrieve(
        db, user_id=user.id, folder_ids=folder_ids, query=q, limit=limit
    )
    return SearchResponse(
        query=q,
        low_confidence=result.low_confidence,
        elapsed_ms=result.elapsed_ms,
        results=[
            SearchHit(
                chunk_id=h.chunk_id,
                file_id=h.file_id,
                filename=h.filename,
                folder_name=h.folder_name,
                page_number=h.page_number,
                heading=h.heading,
                text=h.text,
                score=h.score,
            )
            for h in result.hits
        ],
    )
