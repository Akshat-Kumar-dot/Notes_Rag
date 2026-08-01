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
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
