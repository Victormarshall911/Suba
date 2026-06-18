"""
SUBA Backend — Transaction Schemas
=====================================
Pydantic v2 request/response models for transaction and purchase endpoints.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


# =============================================================================
# Request Schemas
# =============================================================================

class PurchaseDataRequest(BaseModel):
    """
    Schema for POST /api/v1/purchase/data

    This is the critical VTU purchase request. All fields are validated
    before the purchase engine begins its 8-step execution flow.
    """

    recipient_phone: str = Field(
        ...,
        min_length=10,
        max_length=14,
        description="Recipient phone number",
        examples=["08031234567"],
    )

    network: str = Field(
        ...,
        description="Mobile network provider",
        examples=["MTN"],
    )

    plan_code: str = Field(
        ...,
        description="VTU data plan identifier",
        examples=["m1"],
    )

    amount: Decimal = Field(
        ...,
        gt=0,
        description="Purchase amount in Nigerian Naira (₦)",
        examples=[260.00],
    )

    wallet_pin: str = Field(
        ...,
        min_length=4,
        max_length=4,
        description="4-digit wallet transaction PIN",
        examples=["1234"],
    )

    @field_validator("recipient_phone")
    @classmethod
    def normalize_recipient_phone(cls, v: str) -> str:
        """Normalize phone number to 0-prefix format."""
        cleaned = v.strip().replace("-", "").replace(" ", "")
        if cleaned.startswith("+234"):
            cleaned = "0" + cleaned[4:]
        elif cleaned.startswith("234") and len(cleaned) == 13:
            cleaned = "0" + cleaned[3:]
        return cleaned

    @field_validator("network")
    @classmethod
    def validate_network(cls, v: str) -> str:
        """Validate and normalize network name."""
        allowed = {"MTN", "AIRTEL", "GLO", "9MOBILE"}
        normalized = v.upper().strip()
        if normalized not in allowed:
            raise ValueError(f"Network must be one of: {', '.join(sorted(allowed))}")
        return normalized

    @field_validator("wallet_pin")
    @classmethod
    def validate_pin_format(cls, v: str) -> str:
        """Ensure PIN is exactly 4 digits."""
        if not v.isdigit():
            raise ValueError("Wallet PIN must be exactly 4 digits")
        return v


# =============================================================================
# Response Schemas
# =============================================================================

class TransactionResponse(BaseModel):
    """
    Full transaction details returned in API responses.
    Excludes internal fields like provider_response raw data.
    """

    id: uuid.UUID
    user_id: uuid.UUID
    wallet_id: uuid.UUID
    type: str
    amount: Decimal
    status: str
    reference: str
    recipient_phone: Optional[str] = None
    network: Optional[str] = None
    plan_code: Optional[str] = None
    narration: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TransactionListResponse(BaseModel):
    """
    Paginated list of transactions returned by GET /api/v1/wallet/transactions
    """

    items: List[TransactionResponse] = Field(
        ...,
        description="List of transaction records",
    )
    total: int = Field(
        ...,
        description="Total number of transactions matching the query",
    )
    page: int = Field(
        ...,
        description="Current page number (1-indexed)",
    )
    size: int = Field(
        ...,
        description="Number of items per page",
    )


class WebhookPaystackEvent(BaseModel):
    """
    Schema representing the relevant portion of a Paystack webhook event.
    Only used internally for parsing — not exposed as an API response.
    """

    event: str = Field(..., description="Paystack event type, e.g. 'charge.success'")
    data: dict = Field(..., description="Event payload containing transaction details")
