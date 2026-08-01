from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# Neon's free compute allows few connections. Keep the pool small now, before
# background jobs start multiplying it.
engine = create_async_engine(
    settings.async_database_url,
    connect_args={"ssl": "require"},
    pool_size=3,
    max_overflow=2,
    pool_pre_ping=True,
    pool_recycle=280,   # Neon drops idle connections; recycle before it does
    echo=not settings.is_prod,
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as db:
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise
