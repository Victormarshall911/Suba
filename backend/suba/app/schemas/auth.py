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

    firebase_token: str = Field(
        ...,
        description="Firebase ID Token obtained after phone verification on the frontend",
        examples=["eyJhbGciOiJSUzI1NiIsImtp..."],
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

    The frontend sends phone number (not email) as the login identifier.
    """

    phone_number: str = Field(
        ...,
        description="Nigerian phone number used during registration",
        examples=["08031234567"],
    )

    password: str = Field(
        ...,
        description="Account password",
        examples=["SecurePass1"],
    )

    @field_validator("phone_number")
    @classmethod
    def normalize_phone(cls, v: str) -> str:
        """Normalize phone number to 0-prefix format."""
        cleaned = v.strip().replace("-", "").replace(" ", "")
        if cleaned.startswith("+234"):
            cleaned = "0" + cleaned[4:]
        elif cleaned.startswith("234") and len(cleaned) == 13:
            cleaned = "0" + cleaned[3:]
        return cleaned


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
