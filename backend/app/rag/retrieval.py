"""Hybrid retrieval: dense (pgvector) + lexical (tsvector), fused with RRF.

Dense embeddings are weak on exact tokens -- error codes, model names, arXiv ids
-- which are exactly what people search their own notes for. The lexical arm
catches those. RRF is used instead of blending scores because cosine distance
and ts_rank are not on comparable scales; normalising them would be guesswork.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text as sql
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.rag.embeddings import embed_query

log = logging.getLogger(__name__)


@dataclass(slots=True)
class Hit:
    chunk_id: UUID
    file_id: UUID
    folder_id: UUID
    filename: str
    folder_name: str
    page_number: int | None
    heading: str | None
    text: str
    dense_score: float | None
    sparse_score: float | None
    score: float


@dataclass(slots=True)
class Retrieved:
    hits: list[Hit]
    low_confidence: bool
    elapsed_ms: int


_SQL = sql(
    """
WITH dense AS (
    SELECT c.id,
           1 - (c.embedding <=> CAST(:qvec AS vector)) AS score,
           ROW_NUMBER() OVER (ORDER BY c.embedding <=> CAST(:qvec AS vector)) AS rank
    FROM chunks c
    WHERE c.user_id = :user_id AND c.folder_id = ANY(:folder_ids)
    ORDER BY c.embedding <=> CAST(:qvec AS vector)
    LIMIT :dense_k
),
sparse AS (
    SELECT c.id,
           ts_rank_cd(c.tsv, websearch_to_tsquery('english', :qtext)) AS score,
           ROW_NUMBER() OVER (
               ORDER BY ts_rank_cd(c.tsv, websearch_to_tsquery('english', :qtext)) DESC
           ) AS rank
    FROM chunks c
    WHERE c.user_id = :user_id AND c.folder_id = ANY(:folder_ids)
      AND c.tsv @@ websearch_to_tsquery('english', :qtext)
    LIMIT :sparse_k
),
fused AS (
    SELECT COALESCE(d.id, s.id) AS id,
           d.score AS dense_score,
           s.score AS sparse_score,
           COALESCE(1.0 / (:rrf_k + d.rank), 0.0)
             + COALESCE(1.0 / (:rrf_k + s.rank), 0.0) AS score
    FROM dense d FULL OUTER JOIN sparse s ON s.id = d.id
)
SELECT f.id AS chunk_id, f.dense_score, f.sparse_score, f.score,
       c.text, c.heading, c.page_number,
       fi.id AS file_id, c.folder_id, fi.original_filename, fo.name AS folder_name
FROM fused f
JOIN chunks c  ON c.id = f.id
JOIN files fi  ON fi.id = c.file_id
JOIN folders fo ON fo.id = c.folder_id
ORDER BY f.score DESC
LIMIT :limit
"""
)


# pgvector added hnsw.iterative_scan in 0.8.0. Probed once by version rather than
# try/except: a failed SET would need a rollback, and rolling back the caller's
# transaction mid-request is far worse than the missing optimisation.
_ITERATIVE_SCAN: bool | None = None


async def _enable_iterative_scan(db: AsyncSession) -> None:
    """Filtered vector search can under-return: HNSW finds the globally nearest
    rows, then the folder filter discards most of them, leaving 3 results where
    40 were asked for. Iterative scan makes pgvector keep searching until the
    filter is satisfied."""
    global _ITERATIVE_SCAN

    if _ITERATIVE_SCAN is None:
        raw = await db.scalar(
            sql("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        )
        try:
            major, minor, *_ = (int(p) for p in str(raw).split("."))
            _ITERATIVE_SCAN = (major, minor) >= (0, 8)
        except (ValueError, TypeError):
            _ITERATIVE_SCAN = False
        if not _ITERATIVE_SCAN:
            log.warning(
                "pgvector %s lacks hnsw.iterative_scan (needs 0.8+). Folder-filtered "
                "searches may return fewer candidates than requested.", raw,
            )

    if _ITERATIVE_SCAN:
        await db.execute(sql("SET LOCAL hnsw.iterative_scan = relaxed_order"))


async def retrieve(
    db: AsyncSession,
    *,
    user_id: UUID,
    folder_ids: list[UUID],
    query: str,
    limit: int | None = None,
) -> Retrieved:
    started = time.perf_counter()
    limit = limit or settings.context_chunks

    if not folder_ids:
        return Retrieved([], True, 0)

    qvec = await embed_query(query)
    await _enable_iterative_scan(db)

    rows = (
        await db.execute(
            _SQL,
            {
                "qvec": str(qvec),
                "qtext": query,
                "user_id": str(user_id),
                "folder_ids": [str(f) for f in folder_ids],
                "dense_k": settings.dense_candidates,
                "sparse_k": settings.sparse_candidates,
                "rrf_k": settings.rrf_k,
                "limit": limit,
            },
        )
    ).mappings().all()

    hits = [
        Hit(
            chunk_id=r["chunk_id"],
            file_id=r["file_id"],
            folder_id=r["folder_id"],
            filename=r["original_filename"],
            folder_name=r["folder_name"],
            page_number=r["page_number"],
            heading=r["heading"],
            text=r["text"],
            dense_score=r["dense_score"],
            sparse_score=r["sparse_score"],
            score=float(r["score"]),
        )
        for r in rows
    ]

    # Without a reranker the fused score is the only quality signal available.
    # Dense cosine on the top hit is the more meaningful of the two.
    best_dense = max((h.dense_score or 0.0) for h in hits) if hits else 0.0
    return Retrieved(
        hits=hits,
        low_confidence=not hits or best_dense < settings.min_score,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
    )
