"""
SUBA Backend — Auth Dependency (JWT Bearer)
=============================================
Provides the `get_current_user` dependency for FastAPI route protection.

This dependency:
    1. Extracts the Bearer token from the Authorization header
    2. Decodes and validates the JWT
    3. Queries the user from the database
    4. Returns the User model instance
    5. Raises HTTP 401 if any step fails

Usage in a router:
    @router.get("/me")
    async def me(user: User = Depends(get_current_user)):
        return user
"""

from uuid import UUID

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import UnauthorizedError
from app.core.security import decode_access_token
from app.database import get_db
from app.models.user import User

# ---------------------------------------------------------------------------
# HTTP Bearer scheme — extracts token from "Authorization: Bearer <token>"
# ---------------------------------------------------------------------------
bearer_scheme = HTTPBearer(
    scheme_name="JWT",
    description="JWT access token obtained from /api/v1/auth/login",
    auto_error=False,  # We handle the error ourselves for consistent JSON shape
)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    FastAPI dependency that validates the JWT Bearer token and returns
    the authenticated User model instance.

    Raises:
        UnauthorizedError (HTTP 401): If the token is missing, invalid,
        expired, or the user does not exist / is inactive.
    """

    # -------------------------------------------------------------------------
    # Step 1: Check that a token was provided
    # -------------------------------------------------------------------------
    if credentials is None:
        raise UnauthorizedError(detail="Authorization header missing")

    token = credentials.credentials

    # -------------------------------------------------------------------------
    # Step 2: Decode the JWT and extract the user UUID
    # -------------------------------------------------------------------------
    user_id_str = decode_access_token(token)
    if user_id_str is None:
        raise UnauthorizedError(detail="Invalid or expired access token")

    # -------------------------------------------------------------------------
    # Step 3: Parse the UUID and query the database
    # -------------------------------------------------------------------------
    try:
        user_id = UUID(user_id_str)
    except ValueError:
        raise UnauthorizedError(detail="Invalid token payload")

    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()

    # -------------------------------------------------------------------------
    # Step 4: Validate the user exists and is active
    # -------------------------------------------------------------------------
    if user is None:
        raise UnauthorizedError(detail="User not found")

    if not user.is_active:
        raise UnauthorizedError(detail="User account is deactivated")

    return user
