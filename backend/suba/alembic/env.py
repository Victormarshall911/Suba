"""
SUBA Backend — Alembic Environment Configuration
====================================================
Configures Alembic to use the async SQLAlchemy engine from app.database.
Imports all models so that autogenerate can detect schema changes.

This file overrides the sqlalchemy.url from alembic.ini with the
DATABASE_URL from the application's .env configuration.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.config import get_settings
from app.database import Base

# Import all models so Alembic can see them for autogenerate
from app.models import user, wallet, transaction  # noqa: F401

# ---------------------------------------------------------------------------
# Alembic Config object — provides access to .ini file values
# ---------------------------------------------------------------------------
config = context.config

# Set the database URL from our application config (not from alembic.ini)
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

# Interpret the config file for Python logging (if present)
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Target metadata for autogenerate support
target_metadata = Base.metadata


# =============================================================================
# Offline Migrations — generates SQL scripts without connecting to DB
# =============================================================================

def run_migrations_offline() -> None:
    """
    Run migrations in 'offline' mode.
    Generates SQL scripts to stdout that can be applied manually.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


# =============================================================================
# Online Migrations — connects to DB and applies migrations directly
# =============================================================================

def do_run_migrations(connection: Connection) -> None:
    """Run migrations within a database connection context."""
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """
    Create an async engine and run migrations.
    Uses the asyncpg driver for PostgreSQL.
    """
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """
    Run migrations in 'online' mode.
    Connects to the database and applies migrations directly.
    """
    asyncio.run(run_async_migrations())


# ---------------------------------------------------------------------------
# Determine which mode to run in
# ---------------------------------------------------------------------------
if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
