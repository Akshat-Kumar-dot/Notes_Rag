"""Gemini embeddings over HTTP.

No local model: the whole point of this design is that the server never loads
torch, which is what lets it run in 512MB.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)


class EmbeddingError(RuntimeError):
    pass


async def _post(client: httpx.AsyncClient, payload: dict) -> dict:
    url = (
        f"{settings.gemini_base_url}/models/{settings.embedding_model}:batchEmbedContents"
        f"?key={settings.gemini_api_key}"
    )
    # Free tiers throttle aggressively and one PDF is hundreds of calls, so
    # backoff is load-bearing here, not a nicety.
    delay = 2.0
    for attempt in range(5):
        resp = await client.post(url, json=payload)
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt == 4:
                # Surface Google's own message: a 429 on the first call usually
                # means the model is unavailable to this key, not real throttling.
                raise EmbeddingError(
                    f"Embedding failed (HTTP {resp.status_code}). {resp.text[:500]}"
                )
            log.warning("embedding backoff: HTTP %s, sleeping %.1fs", resp.status_code, delay)
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if resp.status_code >= 400:
            raise EmbeddingError(
                f"Embedding failed (HTTP {resp.status_code}). {resp.text[:500]}"
            )
        return resp.json()
    raise EmbeddingError("Embedding failed after repeated retries.")


def _request(texts: list[str], task_type: str) -> dict:
    return {
        "requests": [
            {
                "model": f"models/{settings.embedding_model}",
                "content": {"parts": [{"text": t}]},
                "taskType": task_type,
                "outputDimensionality": settings.embedding_dim,
            }
            for t in texts
        ]
    }


async def embed_documents(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        for i in range(0, len(texts), settings.embed_batch_size):
            batch = texts[i : i + settings.embed_batch_size]
            data = await _post(client, _request(batch, "RETRIEVAL_DOCUMENT"))
            out.extend(e["values"] for e in data["embeddings"])
    return out


async def embed_query(text: str) -> list[float]:
    """Queries use a different task type than documents -- Gemini embeds them
    into the same space but optimises for asymmetric search."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        data = await _post(client, _request([text], "RETRIEVAL_QUERY"))
    return data["embeddings"][0]["values"]
