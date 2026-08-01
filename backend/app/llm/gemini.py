"""Gemini chat, streaming. Everything provider-specific lives in this file."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

import httpx

from app.config import settings

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    pass


def _body(prompt: str, max_tokens: int) -> dict:
    return {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
    }


async def stream(prompt: str, max_tokens: int = 1200) -> AsyncIterator[str]:
    url = (
        f"{settings.gemini_base_url}/models/{settings.chat_model}:streamGenerateContent"
        f"?alt=sse&key={settings.gemini_api_key}"
    )
    async with httpx.AsyncClient(timeout=180.0) as client:
        try:
            async with client.stream("POST", url, json=_body(prompt, max_tokens)) as resp:
                if resp.status_code == 429:
                    raise LLMError("Rate limit reached. Wait a moment and try again.")
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode()[:300]
                    raise LLMError(f"The model returned an error (HTTP {resp.status_code}). {body}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line.removeprefix("data: ").strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(raw)
                        parts = chunk["candidates"][0]["content"]["parts"]
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    for part in parts:
                        if text := part.get("text"):
                            yield text
        except httpx.HTTPError as exc:
            raise LLMError("Couldn't reach the model service.") from exc


async def complete(prompt: str, max_tokens: int = 200) -> str:
    url = (
        f"{settings.gemini_base_url}/models/{settings.chat_model}:generateContent"
        f"?key={settings.gemini_api_key}"
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json=_body(prompt, max_tokens))
    if resp.status_code >= 400:
        raise LLMError(f"The model returned an error (HTTP {resp.status_code}).")
    try:
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError):
        raise LLMError("The model returned an unexpected response.") from None
