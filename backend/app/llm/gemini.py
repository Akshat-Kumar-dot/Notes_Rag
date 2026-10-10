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


class LLMBusy(LLMError):
    """HTTP 429/503: overloaded or rate limited. Unlike other errors, worth
    retrying after a short wait."""


def _body(prompt: str, max_tokens: int, json_mode: bool = False) -> dict:
    config: dict = {"temperature": 0.2, "maxOutputTokens": max_tokens}
    if json_mode:
        # Makes the model return a bare JSON document, no prose or fences.
        config["responseMimeType"] = "application/json"
    if settings.chat_model.startswith("gemma-4"):
        # Gemma 4 thinks before answering by default, and the thinking spends
        # maxOutputTokens. "minimal" is the only level it accepts; it skips it.
        config["thinkingConfig"] = {"thinkingLevel": "minimal"}
    return {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": config}


async def stream(prompt: str, max_tokens: int = 1200) -> AsyncIterator[str]:
    url = (
        f"{settings.gemini_base_url}/models/{settings.chat_model}:streamGenerateContent"
        f"?alt=sse&key={settings.gemini_api_key}"
    )
    # 60s without a single byte ends it: when the model is overloaded it can
    # hold a connection open for minutes, which is worse than an error.
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        try:
            async with client.stream("POST", url, json=_body(prompt, max_tokens)) as resp:
                if resp.status_code == 429:
                    raise LLMBusy("Rate limit reached. Wait a moment and try again.")
                if resp.status_code == 503:
                    raise LLMBusy("The model is overloaded right now. Try again in a moment.")
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
                        # Thought parts are the model's reasoning, not the answer.
                        if part.get("thought"):
                            continue
                        if text := part.get("text"):
                            yield text
        except httpx.HTTPError as exc:
            raise LLMError("Couldn't reach the model service.") from exc


async def complete(
    prompt: str, max_tokens: int = 200, timeout: float = 30.0, json_mode: bool = False,
) -> str:
    url = (
        f"{settings.gemini_base_url}/models/{settings.chat_model}:generateContent"
        f"?key={settings.gemini_api_key}"
    )
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=_body(prompt, max_tokens, json_mode))
    except httpx.HTTPError as exc:
        # A timeout must surface as LLMError, or callers that treat this call
        # as optional (the query rewrite) crash the whole turn instead.
        raise LLMError("Couldn't reach the model service.") from exc
    if resp.status_code in (429, 503):
        raise LLMBusy("The model is busy right now. Try again in a moment.")
    if resp.status_code >= 400:
        raise LLMError(f"The model returned an error (HTTP {resp.status_code}).")
    try:
        parts = resp.json()["candidates"][0]["content"]["parts"]
        # Gemma 4 puts an (empty) thought part first, so parts[0] isn't the answer.
        return "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
    except (KeyError, IndexError):
        raise LLMError("The model returned an unexpected response.") from None
