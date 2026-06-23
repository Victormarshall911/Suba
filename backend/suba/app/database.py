"""
SUBA Backend — Async Database Engine & Session Factory
========================================================
Creates the async SQLAlchemy engine connected to PostgreSQL (Supabase)
via the asyncpg driver. Provides a session dependency for FastAPI's DI system.

IMPORTANT: The DATABASE_URL is read from config and is NEVER logged.
"""

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


# ---------------------------------------------------------------------------
# Declarative Base — all ORM models inherit from this
# ---------------------------------------------------------------------------
class Base(DeclarativeBase):
    """Base class for all SQLAlchemy ORM models in the SUBA application."""
    pass


# ---------------------------------------------------------------------------
# Engine & Session Factory — initialized lazily at module import time
# ---------------------------------------------------------------------------
settings = get_settings()

engine_kwargs = {
    "echo": (settings.APP_ENV == "development"),
}
if not settings.DATABASE_URL.startswith("sqlite"):
    engine_kwargs.update({
        "pool_pre_ping": True,
        "pool_size": 10,
        "max_overflow": 20,
        # Required for Supabase: PgBouncer uses transaction-mode pooling
        # which does not support prepared statements. Setting
        # statement_cache_size=0 disables asyncpg's prepared statement cache.
        "connect_args": {
            "statement_cache_size": 0,
            "prepared_statement_cache_size": 0,
        },
    })

engine = create_async_engine(
    settings.DATABASE_URL,
    **engine_kwargs
)

async_session_factory = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,  # Prevent lazy-load issues after commit
)


# ---------------------------------------------------------------------------
# FastAPI Dependency — yields an async session per request
# ---------------------------------------------------------------------------
async def get_db() -> AsyncSession:
    """
    FastAPI dependency that provides an async database session.
    The session is automatically closed when the request completes.

    Usage in a router:
        @router.get("/example")
        async def example(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()


def get_session_factory() -> async_sessionmaker:
    """
    FastAPI dependency that provides the async session factory.
    Used by routers that need to create independent DB transactions
    (e.g. the purchase engine's locked transaction + refund flows).

    This is a separate dependency so tests can override it with a
    test-database-bound session factory.
    """
    return async_session_factory
