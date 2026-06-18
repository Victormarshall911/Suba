"""
SUBA Backend — Auth Router
=============================
API endpoints for user authentication and profile management.

Endpoints:
    POST /api/v1/auth/register  — Create a new user + auto-create wallet
    POST /api/v1/auth/login     — Verify credentials, return JWT
    GET  /api/v1/auth/me        — Protected; return current user profile
"""

import structlog
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.schemas.auth import (
    AuthResponse,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
)
from app.services import auth_service

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/auth",
    tags=["Authentication"],
)


# =============================================================================
# POST /register — Create user + auto-create empty wallet
# =============================================================================

@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=201,
    summary="Register a new user",
    description=(
        "Creates a new user account with the provided details. "
        "An empty wallet is automatically created for the user. "
        "Returns a JWT access token and the user profile."
    ),
)
async def register(
    request: UserRegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """
    Register a new SUBA user.

    Steps:
        1. Validate request body (Pydantic handles this)
        2. Check email/phone uniqueness
        3. Hash password with bcrypt
        4. Create user + wallet rows
        5. Generate JWT access token
        6. Return token + user profile (no password_hash)
    """
    return await auth_service.register_user(db=db, request=request)


# =============================================================================
# POST /login — Verify credentials and return JWT
# =============================================================================

@router.post(
    "/login",
    response_model=AuthResponse,
    summary="Log in with email address and password",
    description=(
        "Verifies the user's email address and password. "
        "Returns a JWT access token and the user profile on success."
    ),
)
async def login(
    request: UserLoginRequest,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """
    Authenticate a user and return a JWT token.

    The frontend sends the email as the login identifier.
    """
    return await auth_service.authenticate_user(
        db=db,
        email=request.email,
        password=request.password,
    )


# =============================================================================
# GET /me — Protected; return current user profile
# =============================================================================

@router.get(
    "/me",
    response_model=UserResponse,
    summary="Get current user profile",
    description=(
        "Returns the authenticated user's profile. "
        "Requires a valid JWT Bearer token in the Authorization header."
    ),
)
async def me(
    current_user: User = Depends(get_current_user),
) -> UserResponse:
    """
    Return the profile of the currently authenticated user.
    password_hash is excluded from the response by the schema.
    """
    return UserResponse.model_validate(current_user)
