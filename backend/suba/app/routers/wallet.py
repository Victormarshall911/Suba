"""
SUBA Backend — Wallet Router
================================
API endpoints for wallet operations.

Endpoints:
    GET  /api/v1/wallet/balance       — Get current wallet balance
    POST /api/v1/wallet/set-pin       — Set/update 4-digit transaction PIN
    GET  /api/v1/wallet/transactions  — Paginated transaction history
"""

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.schemas.transaction import TransactionListResponse
from app.schemas.wallet import SetPinRequest, SetPinResponse, WalletBalanceResponse
from app.services import wallet_service

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/wallet",
    tags=["Wallet"],
)


# =============================================================================
# GET /balance — Return wallet balance for current user
# =============================================================================

@router.get(
    "/balance",
    response_model=WalletBalanceResponse,
    summary="Get wallet balance",
    description="Returns the current wallet balance and last update timestamp.",
)
async def get_balance(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WalletBalanceResponse:
    """Retrieve the authenticated user's wallet balance."""
    return await wallet_service.get_balance(db=db, user_id=current_user.id)


# =============================================================================
# POST /set-pin — Set/update wallet transaction PIN
# =============================================================================

@router.post(
    "/set-pin",
    response_model=SetPinResponse,
    summary="Set transaction PIN",
    description=(
        "Set or update the 4-digit transaction PIN for the user's wallet. "
        "The PIN is hashed with bcrypt before storage and can never be recovered."
    ),
)
async def set_pin(
    request: SetPinRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SetPinResponse:
    """Set or update the wallet transaction PIN."""
    return await wallet_service.set_pin(
        db=db,
        user_id=current_user.id,
        pin=request.pin,
    )


# =============================================================================
# GET /transactions — Paginated transaction history
# =============================================================================

@router.get(
    "/transactions",
    response_model=TransactionListResponse,
    summary="Get transaction history",
    description=(
        "Returns a paginated list of the user's transactions, "
        "ordered by most recent first."
    ),
)
async def get_transactions(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    size: int = Query(20, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TransactionListResponse:
    """Retrieve paginated transaction history for the current user."""
    return await wallet_service.get_transactions(
        db=db,
        user_id=current_user.id,
        page=page,
        size=size,
    )
