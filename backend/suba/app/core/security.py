"""
SUBA Backend — Security Utilities
====================================
Provides password hashing, PIN hashing, and JWT token creation/verification.

Dependencies:
    - passlib[bcrypt]: Password and PIN hashing via bcrypt
    - python-jose[cryptography]: JWT creation and decoding

Security Design:
    - Passwords are hashed with bcrypt (cost factor 12)
    - 4-digit wallet PINs are also bcrypt-hashed (never stored plaintext)
    - JWTs use HS256 algorithm with a configurable expiry
    - Tokens include a `sub` claim with the user UUID as a string
"""

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import get_settings

# ---------------------------------------------------------------------------
# Password Hashing Context — bcrypt with automatic salt
# ---------------------------------------------------------------------------
pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
    bcrypt__rounds=12,  # Cost factor — balance between security and speed
)


# ---------------------------------------------------------------------------
# Password Operations
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    """
    Hash a plaintext password using bcrypt.

    Args:
        password: The plaintext password to hash.

    Returns:
        The bcrypt hash string (includes salt and cost factor).
    """
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verify a plaintext password against a bcrypt hash.

    Args:
        plain_password: The plaintext password to check.
        hashed_password: The bcrypt hash to verify against.

    Returns:
        True if the password matches, False otherwise.
    """
    return pwd_context.verify(plain_password, hashed_password)


# ---------------------------------------------------------------------------
# PIN Operations — Same bcrypt approach, separate functions for clarity
# ---------------------------------------------------------------------------
def hash_pin(pin: str) -> str:
    """
    Hash a 4-digit wallet transaction PIN using bcrypt.

    Args:
        pin: A 4-digit string PIN.

    Returns:
        The bcrypt hash of the PIN.
    """
    return pwd_context.hash(pin)


def verify_pin(plain_pin: str, hashed_pin: str) -> bool:
    """
    Verify a plaintext 4-digit PIN against its bcrypt hash.

    Args:
        plain_pin: The plaintext PIN to check.
        hashed_pin: The bcrypt hash to verify against.

    Returns:
        True if the PIN matches, False otherwise.
    """
    return pwd_context.verify(plain_pin, hashed_pin)


# ---------------------------------------------------------------------------
# JWT Token Operations
# ---------------------------------------------------------------------------
def create_access_token(
    user_id: UUID,
    expires_delta: Optional[timedelta] = None,
) -> str:
    """
    Create a JWT access token for a given user.

    The token includes:
        - sub: User UUID as a string (the subject claim)
        - exp: Expiration timestamp

    Args:
        user_id: The UUID of the user to create a token for.
        expires_delta: Optional custom expiration duration. Defaults to
                       JWT_ACCESS_TOKEN_EXPIRE_MINUTES from settings.

    Returns:
        Encoded JWT string.
    """
    settings = get_settings()

    if expires_delta is None:
        expires_delta = timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)

    expire = datetime.now(timezone.utc) + expires_delta

    payload = {
        "sub": str(user_id),  # Subject — user UUID
        "exp": expire,        # Expiration timestamp
        "iat": datetime.now(timezone.utc),  # Issued at
    }

    return jwt.encode(
        payload,
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )


def decode_access_token(token: str) -> Optional[str]:
    """
    Decode and verify a JWT access token.

    Args:
        token: The encoded JWT string.

    Returns:
        The user UUID string (from the `sub` claim) if valid, None otherwise.

    Raises:
        Does NOT raise — returns None on any validation failure.
        The calling code (dependency layer) is responsible for raising HTTP 401.
    """
    settings = get_settings()

    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            return None
        return user_id
    except JWTError:
        return None
