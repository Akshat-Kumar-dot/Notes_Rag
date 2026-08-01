"""Which chat models can this key actually use? Run: python list_chat_models.py"""
import asyncio, httpx
from app.config import settings


async def main():
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(
            f"{settings.gemini_base_url}/models"
            f"?key={settings.gemini_api_key}&pageSize=200"
        )
        models = [
            m["name"].removeprefix("models/")
            for m in r.json().get("models", [])
            if "generateContent" in m.get("supportedGenerationMethods", [])
        ]
        print("generateContent models available to you:\n")
        for m in models:
            print("  ", m)

        # Try the cheap/fast ones in order and report which actually work.
        print("\nlive test (looking for the cheapest one that responds):")
        for name in [m for m in models if "flash" in m or "lite" in m][:8]:
            rr = await c.post(
                f"{settings.gemini_base_url}/models/{name}:generateContent"
                f"?key={settings.gemini_api_key}",
                json={"contents": [{"role": "user", "parts": [{"text": "say hi"}]}]},
            )
            mark = "OK " if rr.status_code < 400 else "   "
            print(f"  {mark}{name:42} HTTP {rr.status_code}")


asyncio.run(main())
