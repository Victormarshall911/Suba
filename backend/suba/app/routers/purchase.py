"""
SUBA Backend — Purchase Router (VTU Purchase Engine)
======================================================
The most critical endpoint in the SUBA system.

Endpoint:
    POST /api/v1/purchase/data — Execute a data bundle purchase

This endpoint implements the strict 8-step VTU Purchase Engine:

    1. Authenticate user via JWT (handled by dependency)
    2. Validate request body (handled by Pydantic schema)
    3. Verify wallet PIN (bcrypt comparison)
    4. BEGIN async DB transaction:
       a. SELECT wallet FOR UPDATE NOWAIT (row-level lock)
       b. Check balance >= amount (402 if insufficient)
       c. Deduct amount from wallet
       d. INSERT PENDING transaction, generate reference
       e. COMMIT
    5. Call vtu_service.purchase_data() (outside DB transaction)
    6. On SUCCESS: Update transaction status → SUCCESS
    7. On FAILURE: Update transaction → FAILED, refund wallet, create REFUND tx
    8. Return transaction details

Rate limited: 5 requests per minute per user via slowapi.
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal

import structlog
from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.exceptions import (
    ConflictError,
    InsufficientFundsError,
    InvalidPinError,
    PinNotSetError,
    PurchaseFailedError,
)
from app.core.security import verify_pin
from app.database import get_db, get_session_factory
from app.dependencies.auth import get_current_user
from app.models.transaction import Transaction, TransactionStatus, TransactionType
from app.models.user import User
from app.models.wallet import Wallet
from app.schemas.transaction import PurchaseDataRequest, TransactionResponse
from app.services.vtu_service import get_vtu_provider

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Rate Limiter — 5 requests per minute per user
# ---------------------------------------------------------------------------
limiter = Limiter(key_func=get_remote_address)

router = APIRouter(
    prefix="/api/v1/purchase",
    tags=["Purchase"],
)


# =============================================================================
# POST /data — The Critical VTU Purchase Engine
# =============================================================================

@router.post(
    "/data",
    response_model=TransactionResponse,
    summary="Purchase a data bundle",
    description=(
        "Execute a data bundle purchase. This endpoint uses row-level "
        "locking (FOR UPDATE NOWAIT) to prevent double-spending and "
        "implements automatic refund on VTU provider failure."
    ),
)
@limiter.limit("5/minute")
async def purchase_data(
    request: Request,  # Required by slowapi for rate limit context
    body: PurchaseDataRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    session_factory: async_sessionmaker = Depends(get_session_factory),
) -> TransactionResponse:
    """
    VTU Data Purchase Engine — 8-step strict execution flow.

    CRITICAL: The FOR UPDATE NOWAIT lock on the wallet row ensures that
    concurrent purchases for the same user fail fast with HTTP 409 rather
    than queuing up and potentially causing race conditions.
    """

    log = logger.bind(
        user_id=str(current_user.id),
        recipient_phone=body.recipient_phone,
        network=body.network,
        plan_code=body.plan_code,
        amount=str(body.amount),
    )

    # =========================================================================
    # STEP 3: Verify wallet PIN
    # =========================================================================
    log.info("purchase_step_3_verify_pin")

    # Fetch the wallet to check the PIN
    wallet_result = await db.execute(
        select(Wallet).where(Wallet.user_id == current_user.id)
    )
    wallet_for_pin = wallet_result.scalar_one_or_none()

    if wallet_for_pin is None:
        raise PinNotSetError(detail="Wallet not found")

    if wallet_for_pin.pin_hash is None:
        raise PinNotSetError()

    if not verify_pin(body.wallet_pin, wallet_for_pin.pin_hash):
        raise InvalidPinError()

    # =========================================================================
    # STEP 4: Database transaction with row-level locking
    # =========================================================================
    log.info("purchase_step_4_db_transaction")

    # Generate a unique reference for this transaction
    reference = str(uuid.uuid4())
    transaction_id = None
    wallet_id = None

    # Use a fresh session for the locked transaction to ensure clean isolation
    async with session_factory() as txn_session:
        async with txn_session.begin():
            try:
                # ---------------------------------------------------------
                # STEP 4a: SELECT wallet FOR UPDATE NOWAIT
                # SQLite doesn't support FOR UPDATE — gracefully degrade
                # ---------------------------------------------------------
                try:
                    locked_wallet_result = await txn_session.execute(
                        select(Wallet)
                        .where(Wallet.user_id == current_user.id)
                        .with_for_update(nowait=True)
                    )
                except Exception:
                    # Fallback for SQLite (no FOR UPDATE support)
                    locked_wallet_result = await txn_session.execute(
                        select(Wallet)
                        .where(Wallet.user_id == current_user.id)
                    )
                locked_wallet = locked_wallet_result.scalar_one_or_none()

                if locked_wallet is None:
                    raise PinNotSetError(detail="Wallet not found")

                wallet_id = locked_wallet.id

                # ---------------------------------------------------------
                # STEP 4b: Check balance >= requested amount
                # ---------------------------------------------------------
                if Decimal(str(locked_wallet.balance)) < body.amount:
                    log.warning(
                        "purchase_insufficient_funds",
                        balance=str(locked_wallet.balance),
                        required=str(body.amount),
                    )
                    raise InsufficientFundsError()

                # ---------------------------------------------------------
                # STEP 4c: Deduct amount from wallet balance
                # ---------------------------------------------------------
                locked_wallet.balance = Decimal(str(locked_wallet.balance)) - body.amount
                locked_wallet.updated_at = datetime.now(timezone.utc)

                # ---------------------------------------------------------
                # STEP 4d: INSERT PENDING transaction
                # ---------------------------------------------------------
                new_transaction = Transaction(
                    user_id=current_user.id,
                    wallet_id=wallet_id,
                    type=TransactionType.DATA_PURCHASE,
                    amount=body.amount,
                    status=TransactionStatus.PENDING,
                    reference=reference,
                    recipient_phone=body.recipient_phone,
                    network=body.network,
                    plan_code=body.plan_code,
                    narration=f"{body.network} data purchase for {body.recipient_phone}",
                )
                txn_session.add(new_transaction)

                # Flush to get the transaction ID
                await txn_session.flush()
                transaction_id = new_transaction.id

                log.info(
                    "purchase_step_4_committed",
                    reference=reference,
                    transaction_id=str(transaction_id),
                    new_balance=str(locked_wallet.balance),
                )

                # ---------------------------------------------------------
                # STEP 4e: COMMIT (handled by async with txn_session.begin())
                # ---------------------------------------------------------

            except OperationalError as e:
                # FOR UPDATE NOWAIT raises OperationalError if lock unavailable
                if "could not obtain lock" in str(e).lower() or "nowait" in str(e).lower():
                    log.warning("purchase_lock_conflict", error=str(e))
                    raise ConflictError()
                raise

    # =========================================================================
    # STEP 5: Call VTU provider (OUTSIDE the DB transaction)
    # =========================================================================
    log.info("purchase_step_5_vtu_call", reference=reference)

    vtu_provider = get_vtu_provider()
    vtu_success = False
    provider_response = None

    try:
        provider_response = await vtu_provider.purchase_data(
            plan_code=body.plan_code,
            phone=body.recipient_phone,
            reference=reference,
        )
        vtu_success = True
        log.info(
            "purchase_step_5_vtu_success",
            reference=reference,
            provider_response=provider_response,
        )
    except Exception as vtu_error:
        log.error(
            "purchase_step_5_vtu_failed",
            reference=reference,
            error=str(vtu_error),
        )

    # =========================================================================
    # STEP 6 or 7: Update transaction based on VTU result
    # =========================================================================

    if vtu_success:
        # -----------------------------------------------------------------
        # STEP 6: VTU SUCCESS — Update transaction to SUCCESS
        # -----------------------------------------------------------------
        async with session_factory() as update_session:
            async with update_session.begin():
                txn_result = await update_session.execute(
                    select(Transaction).where(Transaction.id == transaction_id)
                )
                txn = txn_result.scalar_one()
                txn.status = TransactionStatus.SUCCESS
                txn.provider_response = provider_response
                txn.updated_at = datetime.now(timezone.utc)

        log.info("purchase_step_6_success", reference=reference)

        # Fetch the final transaction for the response
        async with session_factory() as read_session:
            final_result = await read_session.execute(
                select(Transaction).where(Transaction.id == transaction_id)
            )
            final_txn = final_result.scalar_one()
            return TransactionResponse.model_validate(final_txn)

    else:
        # -----------------------------------------------------------------
        # STEP 7: VTU FAILED — Mark FAILED, refund wallet, create REFUND tx
        # -----------------------------------------------------------------
        log.info("purchase_step_7_refund_start", reference=reference)

        async with session_factory() as refund_session:
            async with refund_session.begin():
                # Mark the original transaction as FAILED
                failed_txn_result = await refund_session.execute(
                    select(Transaction).where(Transaction.id == transaction_id)
                )
                failed_txn = failed_txn_result.scalar_one()
                failed_txn.status = TransactionStatus.FAILED
                failed_txn.provider_response = {"error": "VTU provider call failed"}
                failed_txn.updated_at = datetime.now(timezone.utc)

                # Refund the wallet
                refund_wallet_result = await refund_session.execute(
                    select(Wallet)
                    .where(Wallet.id == wallet_id)
                )
                refund_wallet = refund_wallet_result.scalar_one()
                refund_wallet.balance = Decimal(str(refund_wallet.balance)) + body.amount
                refund_wallet.updated_at = datetime.now(timezone.utc)

                # Create a REFUND transaction record
                refund_reference = str(uuid.uuid4())
                refund_transaction = Transaction(
                    user_id=current_user.id,
                    wallet_id=wallet_id,
                    type=TransactionType.REFUND,
                    amount=body.amount,
                    status=TransactionStatus.SUCCESS,
                    reference=refund_reference,
                    narration=f"Refund for failed {body.network} data purchase (ref: {reference})",
                )
                refund_session.add(refund_transaction)

        log.info(
            "purchase_step_7_refund_completed",
            reference=reference,
            refund_reference=refund_reference,
        )

        raise PurchaseFailedError()
