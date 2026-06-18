"""
SUBA Backend — Auth Tests
============================
Tests for user registration, login, and profile retrieval.

Test Coverage:
    - Successful user registration (creates user + wallet)
    - Duplicate email/phone rejection
    - Successful login with correct credentials
    - Login failure with wrong password
    - GET /me with valid token
    - GET /me without token (401)
"""

import pytest
from httpx import AsyncClient


# =============================================================================
# Registration Tests
# =============================================================================

@pytest.mark.asyncio
async def test_register_success(client: AsyncClient):
    """Test successful user registration creates user + wallet and returns JWT."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "newuser@unilag.edu.ng",
            "phone_number": "08091234567",
            "full_name": "New User",
            "password": "StrongPass1",
        },
    )

    assert response.status_code == 201
    data = response.json()

    # Check response structure
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert "user" in data

    # Check user fields
    user = data["user"]
    assert user["email"] == "newuser@unilag.edu.ng"
    assert user["phone_number"] == "08091234567"
    assert user["full_name"] == "New User"
    assert user["role"] == "USER"
    assert user["is_active"] is True

    # Ensure password_hash is NOT in the response
    assert "password_hash" not in user
    assert "password" not in user


@pytest.mark.asyncio
async def test_register_duplicate_email(client: AsyncClient):
    """Test that registering with an existing email returns 409."""
    # Register first user
    await client.post(
        "/api/v1/auth/register",
        json={
            "email": "dupe@unilag.edu.ng",
            "phone_number": "08091111111",
            "full_name": "First User",
            "password": "StrongPass1",
        },
    )

    # Attempt duplicate email
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "dupe@unilag.edu.ng",
            "phone_number": "08092222222",
            "full_name": "Second User",
            "password": "StrongPass1",
        },
    )

    assert response.status_code == 409
    data = response.json()
    assert data["code"] == "DUPLICATE"
    assert "email" in data["detail"].lower()


@pytest.mark.asyncio
async def test_register_duplicate_phone(client: AsyncClient):
    """Test that registering with an existing phone number returns 409."""
    # Register first user
    await client.post(
        "/api/v1/auth/register",
        json={
            "email": "user1@unilag.edu.ng",
            "phone_number": "08093333333",
            "full_name": "User One",
            "password": "StrongPass1",
        },
    )

    # Attempt duplicate phone
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "user2@unilag.edu.ng",
            "phone_number": "08093333333",
            "full_name": "User Two",
            "password": "StrongPass1",
        },
    )

    assert response.status_code == 409
    data = response.json()
    assert data["code"] == "DUPLICATE"
    assert "phone" in data["detail"].lower()


@pytest.mark.asyncio
async def test_register_weak_password(client: AsyncClient):
    """Test that weak passwords are rejected by validation."""
    # No uppercase
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "weak@unilag.edu.ng",
            "phone_number": "08094444444",
            "full_name": "Weak User",
            "password": "weakpass1",
        },
    )
    assert response.status_code == 422  # Pydantic validation error


@pytest.mark.asyncio
async def test_register_invalid_phone(client: AsyncClient):
    """Test that invalid Nigerian phone numbers are rejected."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "invalid@unilag.edu.ng",
            "phone_number": "1234567",
            "full_name": "Invalid Phone",
            "password": "StrongPass1",
        },
    )
    assert response.status_code == 422


# =============================================================================
# Login Tests
# =============================================================================

@pytest.mark.asyncio
async def test_login_success(client: AsyncClient):
    """Test successful login with correct credentials returns JWT."""
    # First register a user
    await client.post(
        "/api/v1/auth/register",
        json={
            "email": "login@unilag.edu.ng",
            "phone_number": "08095555555",
            "full_name": "Login User",
            "password": "LoginPass1",
        },
    )

    # Now login
    response = await client.post(
        "/api/v1/auth/login",
        json={
            "phone_number": "08095555555",
            "password": "LoginPass1",
        },
    )

    assert response.status_code == 200
    data = response.json()

    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["user"]["phone_number"] == "08095555555"


@pytest.mark.asyncio
async def test_login_wrong_password(client: AsyncClient):
    """Test login with wrong password returns 401."""
    # Register
    await client.post(
        "/api/v1/auth/register",
        json={
            "email": "wrongpw@unilag.edu.ng",
            "phone_number": "08096666666",
            "full_name": "Wrong PW User",
            "password": "CorrectPass1",
        },
    )

    # Login with wrong password
    response = await client.post(
        "/api/v1/auth/login",
        json={
            "phone_number": "08096666666",
            "password": "WrongPass999",
        },
    )

    assert response.status_code == 401
    data = response.json()
    assert data["code"] == "INVALID_CREDENTIALS"


@pytest.mark.asyncio
async def test_login_nonexistent_phone(client: AsyncClient):
    """Test login with unregistered phone number returns 401."""
    response = await client.post(
        "/api/v1/auth/login",
        json={
            "phone_number": "08099999999",
            "password": "AnyPass123",
        },
    )

    assert response.status_code == 401


# =============================================================================
# Profile Tests (/me)
# =============================================================================

@pytest.mark.asyncio
async def test_me_authenticated(client: AsyncClient):
    """Test GET /me with a valid token returns user profile."""
    # Register to get a token
    reg_response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "me@unilag.edu.ng",
            "phone_number": "08097777777",
            "full_name": "Me User",
            "password": "MePass123",
        },
    )
    token = reg_response.json()["access_token"]

    # Call /me
    response = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["email"] == "me@unilag.edu.ng"
    assert data["full_name"] == "Me User"
    assert "password_hash" not in data


@pytest.mark.asyncio
async def test_me_unauthenticated(client: AsyncClient):
    """Test GET /me without a token returns 401."""
    response = await client.get("/api/v1/auth/me")

    assert response.status_code == 401
    data = response.json()
    assert data["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_me_invalid_token(client: AsyncClient):
    """Test GET /me with an invalid token returns 401."""
    response = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": "Bearer invalid.token.here"},
    )

    assert response.status_code == 401
