"""
SUBA Backend — Purchase & Webhook Tests
==========================================
Tests for the critical VTU purchase engine and Paystack webhook logic.

Coverage:
    - Successful data purchase
    - Insufficient funds rejection (402)
    - Wrong PIN rejection
    - PIN not set rejection
    - Failed VTU triggers refund
    - Webhook duplicate delivery idempotency
    - Webhook signature verification
"""

import hashlib
import hmac
import json
import uuid
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.transaction import Transaction, TransactionStatus
from app.models.wallet import Wallet


@pytest.mark.asyncio
async def test_purchase_data_success(client: AsyncClient, auth_headers: dict, test_user, db_session: AsyncSession):
    """Test successful data purchase deducts balance and creates transaction."""
    # Mock VTU provider to always succeed
    with patch("app.routers.purchase.get_vtu_provider") as mock_provider:
        mock_instance = AsyncMock()
        mock_instance.purchase_data.return_value = {
            "success": True, "message": "OK", "provider_reference": "MOCK-001",
        }
        mock_provider.return_value = mock_instance

        response = await client.post("/api/v1/purchase/data", headers=auth_headers, json={
            "recipient_phone": "08031234567", "network": "MTN",
            "plan_code": "m1", "amount": 260.00, "wallet_pin": "1234",
        })

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "SUCCESS"
    assert data["type"] == "DATA_PURCHASE"
    assert float(data["amount"]) == 260.00
    assert data["network"] == "MTN"
    assert data["recipient_phone"] == "08031234567"


@pytest.mark.asyncio
async def test_purchase_insufficient_funds(client: AsyncClient, auth_headers: dict):
    """Test purchase with amount > balance returns 402."""
    with patch("app.routers.purchase.get_vtu_provider"):
        response = await client.post("/api/v1/purchase/data", headers=auth_headers, json={
            "recipient_phone": "08031234567", "network": "MTN",
            "plan_code": "m1", "amount": 99999.00, "wallet_pin": "1234",
        })

    assert response.status_code == 402
    assert response.json()["code"] == "INSUFFICIENT_FUNDS"


@pytest.mark.asyncio
async def test_purchase_wrong_pin(client: AsyncClient, auth_headers: dict):
    """Test purchase with wrong PIN returns 400."""
    response = await client.post("/api/v1/purchase/data", headers=auth_headers, json={
        "recipient_phone": "08031234567", "network": "MTN",
        "plan_code": "m1", "amount": 260.00, "wallet_pin": "9999",
    })
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_PIN"


@pytest.mark.asyncio
async def test_purchase_pin_not_set(client: AsyncClient):
    """Test purchase when user has no PIN set returns 400."""
    # Register a new user (no PIN)
    reg = await client.post("/api/v1/auth/register", json={
        "email": "nopin@unilag.edu.ng", "phone_number": "08083456789",
        "full_name": "No Pin User", "password": "NoPin1234",
    })
    token = reg.json()["access_token"]

    response = await client.post("/api/v1/purchase/data",
        headers={"Authorization": f"Bearer {token}"}, json={
        "recipient_phone": "08031234567", "network": "MTN",
        "plan_code": "m1", "amount": 260.00, "wallet_pin": "1234",
    })
    assert response.status_code == 400
    assert response.json()["code"] == "PIN_NOT_SET"


@pytest.mark.asyncio
async def test_purchase_vtu_failure_triggers_refund(client: AsyncClient, auth_headers: dict, test_user):
    """Test that a failed VTU call refunds the wallet and returns 502."""
    with patch("app.routers.purchase.get_vtu_provider") as mock_provider:
        mock_instance = AsyncMock()
        mock_instance.purchase_data.side_effect = Exception("VTU provider error")
        mock_provider.return_value = mock_instance

        response = await client.post("/api/v1/purchase/data", headers=auth_headers, json={
            "recipient_phone": "08031234567", "network": "MTN",
            "plan_code": "m1", "amount": 500.00, "wallet_pin": "1234",
        })

    assert response.status_code == 502
    assert response.json()["code"] == "PURCHASE_FAILED"

    # Verify wallet was refunded using a fresh session from the test factory
    from tests.conftest import TestSessionLocal
    async with TestSessionLocal() as verify_session:
        wallet_result = await verify_session.execute(
            select(Wallet).where(Wallet.user_id == test_user.id)
        )
        wallet = wallet_result.scalar_one()
        assert Decimal(str(wallet.balance)) == Decimal("5000.00")


@pytest.mark.asyncio
async def test_purchase_invalid_network(client: AsyncClient, auth_headers: dict):
    """Test purchase with invalid network name returns 422."""
    response = await client.post("/api/v1/purchase/data", headers=auth_headers, json={
        "recipient_phone": "08031234567", "network": "INVALID_NET",
        "plan_code": "m1", "amount": 260.00, "wallet_pin": "1234",
    })
    assert response.status_code == 422


# =============================================================================
# Webhook Tests
# =============================================================================

def _make_paystack_signature(body: bytes, secret: str) -> str:
    """Helper to generate valid Paystack HMAC-SHA512 signature."""
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha512).hexdigest()


@pytest.mark.asyncio
async def test_webhook_invalid_signature(client: AsyncClient):
    """Test webhook with invalid signature returns 400."""
    payload = json.dumps({"event": "charge.success", "data": {"reference": "ref123"}})
    response = await client.post("/webhooks/paystack",
        content=payload, headers={
            "Content-Type": "application/json",
            "X-Paystack-Signature": "invalidsignature",
        })
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_SIGNATURE"


@pytest.mark.asyncio
async def test_webhook_ignores_non_charge_events(client: AsyncClient):
    """Test webhook ignores events other than charge.success."""
    payload = json.dumps({"event": "transfer.success", "data": {}}).encode()

    with patch("app.routers.webhooks.verify_paystack_signature", return_value=True):
        response = await client.post("/webhooks/paystack",
            content=payload, headers={
                "Content-Type": "application/json",
                "X-Paystack-Signature": "valid",
            })
    assert response.status_code == 200
    assert "ignored" in response.json()["message"].lower()


@pytest.mark.asyncio
async def test_webhook_duplicate_delivery(client: AsyncClient, test_user, db_session: AsyncSession):
    """Test that sending the same webhook reference twice only credits once."""
    reference = str(uuid.uuid4())
    payload = json.dumps({
        "event": "charge.success",
        "data": {
            "reference": reference,
            "amount": 100000,  # ₦1,000 in kobo
            "customer": {"email": test_user.email},
        },
    }).encode()

    with patch("app.routers.webhooks.verify_paystack_signature", return_value=True):
        # First delivery
        r1 = await client.post("/webhooks/paystack",
            content=payload, headers={
                "Content-Type": "application/json",
                "X-Paystack-Signature": "valid",
            })
        assert r1.status_code == 200

        # Second delivery (duplicate)
        r2 = await client.post("/webhooks/paystack",
            content=payload, headers={
                "Content-Type": "application/json",
                "X-Paystack-Signature": "valid",
            })
        assert r2.status_code == 200
        assert "already processed" in r2.json()["message"].lower()
