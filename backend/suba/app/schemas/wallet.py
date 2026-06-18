"""
SUBA Backend — Wallet Schemas
================================
Pydantic v2 request/response models for wallet-related endpoints.

Wallet PIN is always hashed — the pin_hash field is NEVER returned in responses.
"""

from datetime import datetime
from typing import Optional
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator


# =============================================================================
# Request Schemas
# =============================================================================

class SetPinRequest(BaseModel):
    """
    Schema for POST /api/v1/wallet/set-pin

    Validates that the PIN is exactly 4 digits.
    """

    pin: str = Field(
        ...,
        min_length=4,
        max_length=4,
        description="4-digit transaction PIN",
        examples=["1234"],
    )

    @field_validator("pin")
    @classmethod
    def validate_pin_digits(cls, v: str) -> str:
        """Ensure PIN contains only digits."""
        if not v.isdigit():
            raise ValueError("PIN must contain exactly 4 digits")
        return v


# =============================================================================
# Response Schemas
# =============================================================================

class WalletBalanceResponse(BaseModel):
    """
    Response for GET /api/v1/wallet/balance

    Returns the current wallet balance in Naira and the last update timestamp.
    NOTE: pin_hash is intentionally excluded from all responses.
    """

    balance: Decimal = Field(
        ...,
        description="Current wallet balance in Nigerian Naira (₦)",
    )
    updated_at: datetime = Field(
        ...,
        description="Last wallet modification timestamp",
    )

    model_config = ConfigDict(from_attributes=True)


class SetPinResponse(BaseModel):
    """Response for POST /api/v1/wallet/set-pin"""

    message: str = Field(
        default="Transaction PIN set successfully",
        description="Success confirmation message",
    )
