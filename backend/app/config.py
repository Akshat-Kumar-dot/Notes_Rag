from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["dev", "prod"] = "dev"
    api_prefix: str = "/api/v1"

    # Neon connection string. Paste the one Neon gives you; normalisation below
    # handles the driver prefix and the query params asyncpg rejects.
    database_url: str

    # openssl rand -hex 32 — signs the short-lived OAuth state cookie
    secret_key: str = Field(min_length=32)

    google_client_id: str
    google_client_secret: str

    # Public origin of the deployed app, e.g. https://notes-rag.onrender.com
    # Used to build the OAuth redirect URI. No trailing slash.
    public_base_url: str = "http://localhost:8000"

    session_ttl_days: int = 30

    # --- Gemini API (Gemini embeddings, Gemma 4 answers) ---
    gemini_api_key: str = ""
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    embedding_model: str = "gemini-embedding-001"
    # Gemini supports reduced output dims. 768 keeps vectors small -- Neon's free
    # tier is ~0.5GB and a vector is bigger than the text it came from.
    embedding_dim: int = 768
    # Gemma 4, the open-weights model, served through the Gemini API. The 26B
    # mixture-of-experts variant (4B active) answers in ~2s; gemma-4-31b-it
    # works too but takes 30s+.
    chat_model: str = "gemma-4-26b-a4b-it"

    # --- MongoDB (chat history) ---
    # Local default; on Render set MONGODB_URL to the Atlas connection string.
    mongodb_url: str = "mongodb://localhost:27017"
    mongodb_db: str = "notes_rag"

    # --- guest trial (use without signing in) ---
    # What one trial allows. "Messages" covers Ask AI and Search Notes alike:
    # both call Gemini (search embeds the query).
    guest_uploads: int = 1
    guest_messages: int = 2
    guest_max_upload_mb: int = 5
    # ~450 tokens each, so ~40 pages. Bounds the embedding cost of one upload.
    guest_max_chunks: int = 60
    # Guest accounts and everything they uploaded are deleted after this.
    guest_ttl_hours: int = 24
    # Abuse limits. None of these identify a person perfectly -- IPs are shared
    # and changeable, fingerprints can be faked -- so the daily totals below are
    # what actually bounds the API bill.
    guest_device_window_days: int = 30
    guest_trials_per_ip_per_day: int = 3
    guest_daily_trials: int = 100
    guest_daily_uploads: int = 100
    guest_daily_messages: int = 300
    # Proxies in front of the app that append to X-Forwarded-For. 0 = use the
    # TCP peer (local dev). Render sets it to 1 -- verify with the log line in
    # auth/guest.py after deploying: too high lets clients spoof their IP.
    trusted_proxy_hops: int = 0
    # Shared with the Cloudflare Pages function that serves the frontend and
    # forwards /api/* here (frontend/functions/api/[[path]].js). A request
    # carrying it came through that function, so its X-Client-IP -- set from
    # Cloudflare's CF-Connecting-IP, which visitors can't forge -- is the real
    # visitor. Empty = no Cloudflare in front; only X-Forwarded-For is used.
    proxy_secret: str = ""

    # --- ingest ---
    max_upload_mb: int = 20
    # Per-user cap on total uploaded bytes. Enforced on upload, and what the
    # sidebar meter fills against -- a bar with no real limit behind it would be
    # decoration. Sized for Neon's free tier, which is ~0.5GB for everything.
    storage_limit_mb: int = 500
    chunk_tokens: int = 450
    chunk_overlap_tokens: int = 60
    embed_batch_size: int = 50
    # Keep the original file only when extraction was poor -- those are the ones
    # worth OCRing later. Everything else is deleted once chunks are committed.
    keep_original_below_coverage: float = 0.60

    # --- retrieval ---
    dense_candidates: int = 40
    sparse_candidates: int = 40
    rrf_k: int = 60
    context_chunks: int = 8
    min_score: float = 0.30

    @property
    def is_prod(self) -> bool:
        return self.env == "prod"

    @property
    def async_database_url(self) -> str:
        """Neon hands out `postgresql://...?sslmode=require&channel_binding=require`.
        asyncpg understands neither the prefix nor those params, so strip both and
        pass ssl through connect_args instead."""
        url = self.database_url
        url = url.replace("postgresql+psycopg2://", "postgresql://")
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return url.split("?")[0]

    @property
    def redirect_uri(self) -> str:
        return f"{self.public_base_url}{self.api_prefix}/auth/google/callback"


@lru_cache
def get_settings() -> Settings:
    s = Settings()  # type: ignore[call-arg]
    # On Render there is no MongoDB on localhost. Unchecked, a missing
    # MONGODB_URL surfaced as a 30-second timeout and a stack trace -- after
    # `alembic upgrade head` had already run against the shared database.
    # Checked here (not in a pydantic validator, whose error would echo the
    # settings, secrets included, into the logs), it stops the deploy before
    # either.
    if s.is_prod and any(h in s.mongodb_url for h in ("localhost", "127.0.0.1")):
        raise SystemExit(
            "MONGODB_URL is not set. In production it must be your MongoDB Atlas "
            "connection string (mongodb+srv://...). Set it in Render -> Environment."
        )
    return s


settings = get_settings()
