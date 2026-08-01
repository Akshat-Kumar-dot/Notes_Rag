"""Standalone Gemini check. Run: python diagnose_gemini.py"""
import asyncio, httpx
from app.config import settings

BASE = settings.gemini_base_url
KEY = settings.gemini_api_key


async def main():
    if not KEY:
        print("GEMINI_API_KEY is empty in .env"); return
    print(f"key: {KEY[:8]}...{KEY[-4:]}  ({len(KEY)} chars)\n")

    async with httpx.AsyncClient(timeout=30) as c:
        # 1. Which models does this key actually have?
        r = await c.get(f"{BASE}/models?key={KEY}&pageSize=200")
        print(f"[1] list models -> HTTP {r.status_code}")
        if r.status_code >= 400:
            print(r.text[:600]); return
        models = r.json().get("models", [])
        embed = [m["name"] for m in models
                 if "embedContent" in m.get("supportedGenerationMethods", [])]
        print("    embedding models available to you:")
        for m in embed or ["    (none)"]:
            print("      ", m)

        # 2. Try the configured model, one text, no batching
        print(f"\n[2] embed with configured model: {settings.embedding_model}")
        r = await c.post(
            f"{BASE}/models/{settings.embedding_model}:embedContent?key={KEY}",
            json={"model": f"models/{settings.embedding_model}",
                  "content": {"parts": [{"text": "hello"}]},
                  "taskType": "RETRIEVAL_QUERY",
                  "outputDimensionality": settings.embedding_dim},
        )
        print(f"    -> HTTP {r.status_code}")
        if r.status_code < 400:
            print("    dims:", len(r.json()["embedding"]["values"]))
        else:
            print("   ", r.text[:600])

        # 3. Fallback candidates
        for name in ("text-embedding-004", "embedding-001", "gemini-embedding-exp-03-07"):
            r = await c.post(
                f"{BASE}/models/{name}:embedContent?key={KEY}",
                json={"model": f"models/{name}",
                      "content": {"parts": [{"text": "hello"}]}},
            )
            ok = r.status_code < 400
            dims = len(r.json()["embedding"]["values"]) if ok else "-"
            print(f"\n[3] {name:32} HTTP {r.status_code}  dims={dims}")
            if not ok:
                print("   ", r.text[:250])

        # 4. Chat model
        r = await c.post(
            f"{BASE}/models/{settings.chat_model}:generateContent?key={KEY}",
            json={"contents": [{"role": "user", "parts": [{"text": "say hi"}]}]},
        )
        print(f"\n[4] chat {settings.chat_model} -> HTTP {r.status_code}")
        if r.status_code >= 400:
            print("   ", r.text[:400])


asyncio.run(main())
