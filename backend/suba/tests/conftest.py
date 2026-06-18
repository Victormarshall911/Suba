"""
SUBA Backend — Test Configuration & Fixtures
================================================
Provides shared fixtures for all test modules.
Uses aiosqlite as the async database backend for fast, isolated tests.
"""

import uuid
from decimal import Decimal
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.security import hash_password, hash_pin
from app.database import Base, get_db
from app.models.user import User, UserRole
from app.models.wallet import Wallet


# =============================================================================
# Test Database Engine (SQLite — async via aiosqlite)
# =============================================================================

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(
    TEST_DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)

TestSessionLocal = async_sessionmaker(
    bind=test_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# =============================================================================
# Database Setup — create/drop tables for each test
# =============================================================================

@pytest_asyncio.fixture(autouse=True)
async def setup_database():
    """Create all tables before each test, drop them after."""
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


# =============================================================================
# Database Session Fixture
# =============================================================================

@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """Provide a clean async database session for each test."""
    async with TestSessionLocal() as session:
        yield session


# =============================================================================
# FastAPI Test Client
# =============================================================================

@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Provide an httpx AsyncClient configured to use the test database."""
    from app.main import app
    from app.database import get_session_factory

    async def override_get_db():
        yield db_session

    def override_get_session_factory():
        return TestSessionLocal

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_session_factory] = override_get_session_factory

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


# =============================================================================
# Helper Fixtures — Create Test Users & Wallets
# =============================================================================

@pytest_asyncio.fixture
async def test_user(db_session: AsyncSession) -> User:
    """
    Create and return a test user with known credentials.
    Phone: 08031234567, Password: TestPass123, PIN: 1234, Balance: ₦5000
    """
    user = User(
        id=uuid.uuid4(),
        email="test@unilag.edu.ng",
        phone_number="08031234567",
        full_name="Test User",
        password_hash=hash_password("TestPass123"),
        role=UserRole.USER,
        is_active=True,
    )
    db_session.add(user)
    await db_session.flush()

    wallet = Wallet(
        id=uuid.uuid4(),
        user_id=user.id,
        balance=Decimal("5000.00"),
        pin_hash=hash_pin("1234"),
    )
    db_session.add(wallet)
    await db_session.commit()
    await db_session.refresh(user)

    return user


@pytest_asyncio.fixture
async def auth_headers(test_user: User) -> dict:
    """Return authorization headers with a valid JWT token for the test user."""
    from app.core.security import create_access_token
    token = create_access_token(user_id=test_user.id)
    return {"Authorization": f"Bearer {token}"}
