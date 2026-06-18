"""
SUBA Backend — Wallet Service
================================
Business logic for wallet operations: balance retrieval, PIN management,
and paginated transaction history.

This service handles:
    - Querying wallet balance
    - Setting/updating the 4-digit transaction PIN (bcrypt-hashed)
    - Fetching paginated transaction history for a user
    - Crediting wallet balance (used by webhook funding)
"""

import uuid
from decimal import Decimal
from typing import Optional

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, PinNotSetError
from app.core.security import hash_pin
from app.models.transaction import Transaction
from app.models.wallet import Wallet
from app.schemas.transaction import TransactionListResponse, TransactionResponse
from app.schemas.wallet import SetPinResponse, WalletBalanceResponse

logger = structlog.get_logger()


# =============================================================================
# Balance Retrieval
# =============================================================================

async def get_balance(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> WalletBalanceResponse:
    """
    Retrieve the current wallet balance for a user.

    Args:
        db: Async database session.
        user_id: UUID of the authenticated user.

    Returns:
        WalletBalanceResponse with balance and last update timestamp.

    Raises:
        NotFoundError: If the wallet does not exist (should never happen
                       since wallets are auto-created at registration).
    """
    result = await db.execute(
        select(Wallet).where(Wallet.user_id == user_id)
    )
    wallet = result.scalar_one_or_none()

    if wallet is None:
        raise NotFoundError(detail="Wallet not found")

    return WalletBalanceResponse(
        balance=wallet.balance,
        updated_at=wallet.updated_at,
    )


# =============================================================================
# Transaction PIN Management
# =============================================================================

async def set_pin(
    db: AsyncSession,
    user_id: uuid.UUID,
    pin: str,
) -> SetPinResponse:
    """
    Set or update the 4-digit transaction PIN for a user's wallet.

    The PIN is hashed with bcrypt before storage — it is never stored
    as plaintext and cannot be recovered.

    Args:
        db: Async database session.
        user_id: UUID of the authenticated user.
        pin: 4-digit plaintext PIN to hash and store.

    Returns:
        SetPinResponse with success message.

    Raises:
        NotFoundError: If the wallet does not exist.
    """
    result = await db.execute(
        select(Wallet).where(Wallet.user_id == user_id)
    )
    wallet = result.scalar_one_or_none()

    if wallet is None:
        raise NotFoundError(detail="Wallet not found")

    # Hash the PIN with bcrypt (same approach as passwords)
    wallet.pin_hash = hash_pin(pin)

    await db.commit()

    logger.info(
        "wallet_pin_set",
        user_id=str(user_id),
        wallet_id=str(wallet.id),
    )

    return SetPinResponse(message="Transaction PIN set successfully")


# =============================================================================
# Transaction History (Paginated)
# =============================================================================

async def get_transactions(
    db: AsyncSession,
    user_id: uuid.UUID,
    page: int = 1,
    size: int = 20,
) -> TransactionListResponse:
    """
    Retrieve paginated transaction history for a user.

    Transactions are ordered by created_at descending (newest first).

    Args:
        db: Async database session.
        user_id: UUID of the authenticated user.
        page: Page number (1-indexed). Defaults to 1.
        size: Number of items per page. Defaults to 20, max 100.

    Returns:
        TransactionListResponse with items, total count, page, and size.
    """
    # Clamp page and size to reasonable bounds
    page = max(1, page)
    size = min(max(1, size), 100)
    offset = (page - 1) * size

    # -------------------------------------------------------------------------
    # Count total transactions for this user
    # -------------------------------------------------------------------------
    count_query = select(func.count(Transaction.id)).where(
        Transaction.user_id == user_id
    )
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # -------------------------------------------------------------------------
    # Fetch the requested page
    # -------------------------------------------------------------------------
    items_query = (
        select(Transaction)
        .where(Transaction.user_id == user_id)
        .order_by(Transaction.created_at.desc())
        .offset(offset)
        .limit(size)
    )
    items_result = await db.execute(items_query)
    transactions = items_result.scalars().all()

    return TransactionListResponse(
        items=[TransactionResponse.model_validate(t) for t in transactions],
        total=total,
        page=page,
        size=size,
    )
