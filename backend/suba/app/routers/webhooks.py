"""
SUBA Backend — Webhooks Router
==================================
Handles incoming webhook events from payment providers.

Endpoints:
    POST /webhooks/paystack — Process Paystack payment events

Security:
    Every webhook request is verified via HMAC-SHA512 signature before
    any database operations are performed.

Idempotency:
    Duplicate webhook deliveries (same reference) are silently ignored.
    Paystack may deliver the same event multiple times — we always
    return HTTP 200 to acknowledge receipt.
"""

from datetime import datetime, timezone
from decimal import Decimal

import structlog
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.exceptions import PaystackSignatureError
from app.database import get_session_factory
from app.models.transaction import Transaction, TransactionStatus, TransactionType
from app.models.wallet import Wallet
from app.models.user import User
from app.services.payment_service import verify_paystack_signature

logger = structlog.get_logger()

router = APIRouter(
    prefix="/webhooks",
    tags=["Webhooks"],
)


# =============================================================================
# POST /paystack — Paystack Funding Webhook
# =============================================================================

@router.post(
    "/paystack",
    summary="Paystack webhook handler",
    description=(
        "Receives and processes Paystack webhook events. "
        "Only 'charge.success' events are processed. "
        "All requests are verified via HMAC-SHA512 signature."
    ),
)
async def paystack_webhook(
    request: Request,
    session_factory: async_sessionmaker = Depends(get_session_factory),
) -> dict:
    """
    Paystack Webhook Funding Logic — strict execution order.

    Step 1: Verify HMAC-SHA512 signature
    Step 2: Parse event — only process 'charge.success'
    Step 3: Extract reference from payload
    Step 4: IDEMPOTENCY CHECK — skip if already processed
    Step 5: BEGIN DB transaction:
        a. SELECT wallet FOR UPDATE
        b. Credit wallet balance
        c. INSERT FUNDING transaction
        d. COMMIT
    Step 6: Return HTTP 200
    """

    # =========================================================================
    # STEP 1: Verify Paystack signature
    # =========================================================================
    raw_body = await request.body()
    signature = request.headers.get("X-Paystack-Signature", "")

    if not verify_paystack_signature(raw_body, signature):
        logger.warning("webhook_signature_verification_failed")
        raise PaystackSignatureError()

    # =========================================================================
    # STEP 2: Parse event — only process 'charge.success'
    # =========================================================================
    try:
        payload = await request.json()
    except Exception:
        logger.error("webhook_invalid_json")
        return {"status": "error", "message": "Invalid JSON payload"}

    event_type = payload.get("event", "")

    if event_type != "charge.success":
        logger.info("webhook_ignored_event", event_type=event_type)
        return {"status": "ok", "message": f"Event '{event_type}' ignored"}

    # =========================================================================
    # STEP 3: Extract reference and amount from payload
    # =========================================================================
    event_data = payload.get("data", {})
    reference = event_data.get("reference")
    # Paystack sends amount in kobo — convert to Naira
    amount_kobo = event_data.get("amount", 0)
    amount_naira = Decimal(str(amount_kobo)) / Decimal("100")
    customer_email = event_data.get("customer", {}).get("email", "")

    if not reference:
        logger.error("webhook_missing_reference")
        return {"status": "error", "message": "Missing reference"}

    log = logger.bind(
        reference=reference,
        amount_naira=str(amount_naira),
        customer_email=customer_email,
    )

    log.info("webhook_charge_success_received")

    # =========================================================================
    # STEP 4: IDEMPOTENCY CHECK
    # =========================================================================
    async with session_factory() as check_session:
        existing_result = await check_session.execute(
            select(Transaction).where(
                Transaction.reference == reference,
                Transaction.status == TransactionStatus.SUCCESS,
            )
        )
        existing_txn = existing_result.scalar_one_or_none()

        if existing_txn is not None:
            log.info("webhook_duplicate_ignored", transaction_id=str(existing_txn.id))
            return {"status": "ok", "message": "Already processed"}

    # =========================================================================
    # STEP 5: Credit wallet within DB transaction
    # =========================================================================

    # Look up the user by email to find their wallet
    async with session_factory() as fund_session:
        async with fund_session.begin():
            # Find user by email
            user_result = await fund_session.execute(
                select(User).where(User.email == customer_email)
            )
            user = user_result.scalar_one_or_none()

            if user is None:
                log.error("webhook_user_not_found", email=customer_email)
                # Still return 200 — Paystack expects acknowledgement
                return {"status": "ok", "message": "User not found, event logged"}

            # -----------------------------------------------------------------
            # STEP 5a: SELECT wallet (FOR UPDATE on PostgreSQL)
            # -----------------------------------------------------------------
            try:
                wallet_result = await fund_session.execute(
                    select(Wallet)
                    .where(Wallet.user_id == user.id)
                    .with_for_update()
                )
            except Exception:
                wallet_result = await fund_session.execute(
                    select(Wallet).where(Wallet.user_id == user.id)
                )
            wallet = wallet_result.scalar_one_or_none()

            if wallet is None:
                log.error("webhook_wallet_not_found", user_id=str(user.id))
                return {"status": "ok", "message": "Wallet not found, event logged"}

            # -----------------------------------------------------------------
            # STEP 5b: Credit wallet balance
            # -----------------------------------------------------------------
            wallet.balance = Decimal(str(wallet.balance)) + amount_naira
            wallet.updated_at = datetime.now(timezone.utc)

            # -----------------------------------------------------------------
            # STEP 5c: INSERT FUNDING transaction
            # -----------------------------------------------------------------
            funding_transaction = Transaction(
                user_id=user.id,
                wallet_id=wallet.id,
                type=TransactionType.FUNDING,
                amount=amount_naira,
                status=TransactionStatus.SUCCESS,
                reference=reference,
                narration=f"Wallet funded via Paystack — ₦{amount_naira}",
                provider_response=event_data,
            )
            fund_session.add(funding_transaction)

            # -----------------------------------------------------------------
            # STEP 5d: COMMIT (handled by async with fund_session.begin())
            # -----------------------------------------------------------------

    log.info(
        "webhook_wallet_funded",
        user_id=str(user.id),
        new_balance=str(wallet.balance),
    )

    # =========================================================================
    # STEP 6: Return HTTP 200
    # =========================================================================
    return {"status": "ok", "message": "Webhook processed successfully"}
