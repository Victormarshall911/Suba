"""
SUBA Backend — Wallet Tests
===============================
Tests for wallet balance, PIN management, and transaction history.
"""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_get_balance_authenticated(client: AsyncClient, auth_headers: dict):
    """Test authenticated users can check their wallet balance."""
    response = await client.get("/api/v1/wallet/balance", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert float(data["balance"]) == 5000.00
    assert "updated_at" in data


@pytest.mark.asyncio
async def test_get_balance_unauthenticated(client: AsyncClient):
    """Test unauthenticated requests return 401."""
    response = await client.get("/api/v1/wallet/balance")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_new_user_balance_is_zero(client: AsyncClient):
    """Test newly registered user has ₦0 balance."""
    reg = await client.post("/api/v1/auth/register", json={
        "email": "zerobal@unilag.edu.ng", "phone_number": "08081234567",
        "full_name": "Zero Balance", "password": "ZeroPass1",
    })
    token = reg.json()["access_token"]
    response = await client.get("/api/v1/wallet/balance", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert float(response.json()["balance"]) == 0.00


@pytest.mark.asyncio
async def test_set_pin_success(client: AsyncClient):
    """Test setting a 4-digit wallet PIN."""
    reg = await client.post("/api/v1/auth/register", json={
        "email": "pinuser@unilag.edu.ng", "phone_number": "08082345678",
        "full_name": "PIN User", "password": "PinPass123",
    })
    token = reg.json()["access_token"]
    response = await client.post("/api/v1/wallet/set-pin", json={"pin": "4321"},
        headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["message"] == "Transaction PIN set successfully"


@pytest.mark.asyncio
async def test_set_pin_invalid_format(client: AsyncClient, auth_headers: dict):
    """Test that non-4-digit PINs are rejected."""
    r1 = await client.post("/api/v1/wallet/set-pin", json={"pin": "12"}, headers=auth_headers)
    assert r1.status_code == 422
    r2 = await client.post("/api/v1/wallet/set-pin", json={"pin": "abcd"}, headers=auth_headers)
    assert r2.status_code == 422


@pytest.mark.asyncio
async def test_get_transactions_empty(client: AsyncClient, auth_headers: dict):
    """Test transaction history returns empty list for fresh user."""
    response = await client.get("/api/v1/wallet/transactions", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert data["items"] == []
    assert data["total"] == 0
    assert data["page"] == 1


@pytest.mark.asyncio
async def test_get_transactions_unauthenticated(client: AsyncClient):
    """Test unauthenticated /transactions returns 401."""
    response = await client.get("/api/v1/wallet/transactions")
    assert response.status_code == 401
