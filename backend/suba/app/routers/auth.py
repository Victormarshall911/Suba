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
    CheckEmailRequest,
    CheckPhoneRequest,
    CheckAvailabilityResponse,
    AmbassadorStatsResponse,
    LeaderboardEntry,
)
from app.services import auth_service

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/auth",
    tags=["Authentication"],
)


# =============================================================================
# Pre-Registration Checks
# =============================================================================

@router.post(
    "/check-email",
    response_model=CheckAvailabilityResponse,
    summary="Check email availability",
)
async def check_email(
    request: CheckEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> CheckAvailabilityResponse:
    from sqlalchemy import select
    existing = await db.execute(select(User).where(User.email == request.email))
    is_available = existing.scalar_one_or_none() is None
    return CheckAvailabilityResponse(
        is_available=is_available,
        message="Available" if is_available else "A user with this email already exists"
    )

@router.post(
    "/check-phone",
    response_model=CheckAvailabilityResponse,
    summary="Check phone number availability",
)
async def check_phone(
    request: CheckPhoneRequest,
    db: AsyncSession = Depends(get_db),
) -> CheckAvailabilityResponse:
    from sqlalchemy import select
    existing = await db.execute(select(User).where(User.phone_number == request.phone_number))
    is_available = existing.scalar_one_or_none() is None
    return CheckAvailabilityResponse(
        is_available=is_available,
        message="Available" if is_available else "A user with this phone number already exists"
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
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """
    Return the profile of the currently authenticated user.
    Auto-generates a referral code for legacy users who registered before
    the referral system was added.
    password_hash is excluded from the response by the schema.
    """
    if not current_user.referral_code:
        import random
        import string
        from sqlalchemy import select as sa_select

        def _gen():
            return "SUBA" + "".join(random.choices(string.ascii_uppercase + string.digits, k=6))

        code = _gen()
        while True:
            existing = await db.execute(sa_select(User).where(User.referral_code == code))
            if existing.scalar_one_or_none() is None:
                break
            code = _gen()

        current_user.referral_code = code
        await db.commit()
        await db.refresh(current_user)

    return UserResponse.model_validate(current_user)

# =============================================================================
# GET /ambassador — Protected; return ambassador dashboard stats
# =============================================================================

@router.get(
    "/ambassador",
    response_model=AmbassadorStatsResponse,
    summary="Get ambassador stats",
)
async def get_ambassador_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AmbassadorStatsResponse:
    from sqlalchemy import select, func, desc
    from app.models.transaction import Transaction, TransactionType, TransactionStatus
    from sqlalchemy.orm import aliased
    
    # 1. Calculate my commissions
    # Find all users I referred
    referred_users = await db.execute(select(User.id).where(User.referred_by_id == current_user.id))
    referred_ids = referred_users.scalars().all()
    
    total_commissions = 0.0
    if referred_ids:
        # Sum their successful VTU purchases
        purchase_sum_stmt = select(func.sum(Transaction.amount)).where(
            Transaction.user_id.in_(referred_ids),
            Transaction.type.in_([TransactionType.DATA_PURCHASE, TransactionType.AIRTIME_PURCHASE]),
            Transaction.status == TransactionStatus.SUCCESS
        )
        purchase_sum_result = await db.execute(purchase_sum_stmt)
        total_purchases = purchase_sum_result.scalar() or 0.0
        # 2% commission
        total_commissions = float(total_purchases) * 0.02
        
    # 2. Leaderboard: Top 4 referrers
    ReferredUser = aliased(User)
    leaderboard_stmt = (
        select(User, func.count(ReferredUser.id).label("ref_count"))
        .join(ReferredUser, ReferredUser.referred_by_id == User.id)
        .group_by(User.id)
        .order_by(desc("ref_count"))
        .limit(4)
    )
    lb_result = await db.execute(leaderboard_stmt)
    
    leaderboard = []
    for user_obj, ref_count in lb_result:
        # Estimate commissions for leaderboard (MVP simplification)
        est_commission = ref_count * 1050.0  # mock value based on average referral
        initials = (user_obj.full_name[:2] if user_obj.full_name else "U").upper()
        leaderboard.append(LeaderboardEntry(
            full_name=user_obj.full_name,
            amount=est_commission,
            initials=initials
        ))
        
    # If I am not in the top 4, ensure I am added or at least return the array as is.
    # The frontend can show the array directly.
    
    return AmbassadorStatsResponse(
        total_commissions=total_commissions,
        withdrawn_funds=0.0,
        cleared_balance=total_commissions,
        leaderboard=leaderboard
    )

