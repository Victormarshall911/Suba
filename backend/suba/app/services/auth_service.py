"""
SUBA Backend — Auth Service
==============================
Business logic for user registration, authentication, and profile retrieval.

This service layer sits between the routers and the database/ORM layer.
It handles:
    - User creation with automatic wallet provisioning
    - Credential verification for login
    - Uniqueness checks for email and phone number
"""

import structlog
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import DuplicateResourceError, InvalidCredentialsError
from app.core.security import hash_password, verify_password, create_access_token
from app.models.user import User
from app.models.wallet import Wallet
from app.schemas.auth import AuthResponse, UserRegisterRequest, UserResponse

logger = structlog.get_logger()


# =============================================================================
# Registration
# =============================================================================

async def register_user(
    db: AsyncSession,
    request: UserRegisterRequest,
) -> AuthResponse:
    """
    Register a new user and auto-create an empty wallet.

    Steps:
        1. Check email and phone uniqueness
        2. Hash the password with bcrypt
        3. Create the User row
        4. Create an associated Wallet row (balance = 0)
        5. Generate a JWT access token
        6. Return AuthResponse with token + user profile

    Args:
        db: Async database session.
        request: Validated registration request body.

    Returns:
        AuthResponse containing JWT token and user profile.

    Raises:
        DuplicateResourceError: If email or phone already exists.
    """

    # -------------------------------------------------------------------------
    # Step 1: Check uniqueness before insert (fast fail with clear message)
    # -------------------------------------------------------------------------
    existing_email = await db.execute(
        select(User).where(User.email == request.email)
    )
    if existing_email.scalar_one_or_none() is not None:
        raise DuplicateResourceError(detail="A user with this email already exists")

    existing_phone = await db.execute(
        select(User).where(User.phone_number == request.phone_number)
    )
    if existing_phone.scalar_one_or_none() is not None:
        raise DuplicateResourceError(detail="A user with this phone number already exists")

    # -------------------------------------------------------------------------
    # Step 2: Hash the password
    # -------------------------------------------------------------------------
    hashed_pw = hash_password(request.password)

    # -------------------------------------------------------------------------
    # Step 3: Create the User
    # -------------------------------------------------------------------------
    new_user = User(
        email=request.email,
        phone_number=request.phone_number,
        full_name=request.full_name,
        password_hash=hashed_pw,
    )
    db.add(new_user)

    try:
        await db.flush()  # Flush to get the user ID before creating wallet
    except IntegrityError:
        await db.rollback()
        raise DuplicateResourceError(detail="User with this email or phone already exists")

    # -------------------------------------------------------------------------
    # Step 4: Auto-create an empty wallet for the new user
    # -------------------------------------------------------------------------
    new_wallet = Wallet(
        user_id=new_user.id,
        balance=0.00,
    )
    db.add(new_wallet)

    await db.commit()
    await db.refresh(new_user)

    logger.info(
        "user_registered",
        user_id=str(new_user.id),
        email=new_user.email,
    )

    # -------------------------------------------------------------------------
    # Step 5: Generate JWT
    # -------------------------------------------------------------------------
    access_token = create_access_token(user_id=new_user.id)

    # -------------------------------------------------------------------------
    # Step 6: Build and return response
    # -------------------------------------------------------------------------
    return AuthResponse(
        access_token=access_token,
        token_type="bearer",
        user=UserResponse.model_validate(new_user),
    )


# =============================================================================
# Authentication (Login)
# =============================================================================

async def authenticate_user(
    db: AsyncSession,
    phone_number: str,
    password: str,
) -> AuthResponse:
    """
    Verify user credentials and return a JWT access token.

    Args:
        db: Async database session.
        phone_number: The user's registered phone number.
        password: The plaintext password to verify.

    Returns:
        AuthResponse containing JWT token and user profile.

    Raises:
        InvalidCredentialsError: If phone number not found or password wrong.
    """

    # -------------------------------------------------------------------------
    # Look up user by phone number
    # -------------------------------------------------------------------------
    result = await db.execute(
        select(User).where(User.phone_number == phone_number)
    )
    user = result.scalar_one_or_none()

    if user is None:
        # Do not reveal whether the phone number exists
        raise InvalidCredentialsError()

    # -------------------------------------------------------------------------
    # Verify password
    # -------------------------------------------------------------------------
    if not verify_password(password, user.password_hash):
        raise InvalidCredentialsError()

    # -------------------------------------------------------------------------
    # Check account is active
    # -------------------------------------------------------------------------
    if not user.is_active:
        raise InvalidCredentialsError(detail="Account is deactivated")

    logger.info(
        "user_logged_in",
        user_id=str(user.id),
    )

    # -------------------------------------------------------------------------
    # Generate JWT and return
    # -------------------------------------------------------------------------
    access_token = create_access_token(user_id=user.id)

    return AuthResponse(
        access_token=access_token,
        token_type="bearer",
        user=UserResponse.model_validate(user),
    )
