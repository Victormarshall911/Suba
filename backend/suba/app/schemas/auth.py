"""
SUBA Backend — Auth Schemas
==============================
Pydantic v2 request/response models for authentication endpoints.

These schemas enforce input validation and control what data is serialized
in API responses. password_hash is NEVER included in any response schema.
"""

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator




# =============================================================================
# Request Schemas
# =============================================================================

class UserRegisterRequest(BaseModel):
    """
    Schema for POST /api/v1/auth/register

    Validates:
        - email: Must be a valid email format
        - phone_number: Must be a Nigerian phone number (11 digits, starts with 0)
        - full_name: Non-empty string
        - password: At least 8 characters, 1 uppercase, 1 digit
    """

    email: EmailStr = Field(
        ...,
        description="Valid email address",
        examples=["tobi@unilag.edu.ng"],
    )

    phone_number: str = Field(
        ...,
        min_length=10,
        max_length=14,
        description="Nigerian phone number (e.g. 08031234567 or +2348031234567)",
        examples=["08031234567"],
    )

    full_name: str = Field(
        ...,
        min_length=2,
        max_length=255,
        description="User's full name",
        examples=["Tobi Oyelami"],
    )

    password: str = Field(
        ...,
        min_length=8,
        max_length=128,
        description="Password — min 8 chars, 1 uppercase, 1 digit",
        examples=["SecurePass1"],
    )

    supabase_token: str = Field(
        ...,
        description="Supabase JWT Token obtained after email verification on the frontend",
        examples=["eyJhbGciOiJIUzI1NiIsInR5..."],
    )

    referral_code: str | None = Field(
        default=None,
        max_length=20,
        description="Optional referral code from the user who invited this new user",
        examples=["SUBA1A2B3C"],
    )

    @field_validator("phone_number")
    @classmethod
    def validate_phone_number(cls, v: str) -> str:
        """Normalize and validate Nigerian phone number format."""
        # Remove whitespace and dashes
        cleaned = v.strip().replace("-", "").replace(" ", "")

        # Handle +234 prefix — convert to 0-prefix
        if cleaned.startswith("+234"):
            cleaned = "0" + cleaned[4:]
        elif cleaned.startswith("234") and len(cleaned) == 13:
            cleaned = "0" + cleaned[3:]

        # Validate Nigerian phone format: 11 digits starting with 07/08/09
        if len(cleaned) != 11:
            raise ValueError("Phone number must be 11 digits (e.g. 08031234567)")
        if not cleaned.startswith(("07", "08", "09")):
            raise ValueError("Phone number must start with 07, 08, or 09")
        if not cleaned.isdigit():
            raise ValueError("Phone number must contain only digits")

        return cleaned

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, v: str) -> str:
        """Enforce minimum password strength requirements."""
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        return v


class UserLoginRequest(BaseModel):
    """
    Schema for POST /api/v1/auth/login
    """

    email: EmailStr = Field(
        ...,
        description="User email address used during registration",
        examples=["student@university.edu.ng"],
    )

    password: str = Field(
        ...,
        description="Account password",
        examples=["SecurePass1"],
    )


# =============================================================================
# Response Schemas
# =============================================================================

class UserResponse(BaseModel):
    """
    Public user profile — excludes sensitive fields (password_hash).
    Used in /me endpoint and embedded in AuthResponse.
    """

    id: uuid.UUID
    email: str
    phone_number: str
    full_name: str
    role: str
    is_active: bool
    referral_code: str | None = None
    referred_by_id: uuid.UUID | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AuthResponse(BaseModel):
    """
    Response returned after successful login or registration.
    Includes the JWT access token and the user profile.
    """

    access_token: str = Field(
        ...,
        description="JWT access token for authenticating subsequent requests",
    )
    token_type: str = Field(
        default="bearer",
        description="Token type — always 'bearer'",
    )
    user: UserResponse = Field(
        ...,
        description="Authenticated user profile",
    )


class TokenData(BaseModel):
    """
    Internal schema for decoded JWT payload.
    Not exposed in API responses.
    """

    user_id: Optional[uuid.UUID] = None
