"""
SUBA Backend — Payment Service (Paystack Abstraction Layer)
=============================================================
Abstracts the Paystack payment gateway behind a service interface.
This design allows future replacement with Monnify or other gateways.

Key Responsibilities:
    - Verify Paystack webhook signatures (HMAC-SHA512)
    - Parse and validate webhook event payloads
    - Initialize payment transactions (future feature)

Security:
    The webhook signature verification uses HMAC-SHA512 of the raw request
    body compared against the X-Paystack-Signature header. This ensures
    that only legitimate Paystack events are processed.
"""

import hashlib
import hmac

import structlog

from app.config import get_settings

logger = structlog.get_logger()


# =============================================================================
# Signature Verification
# =============================================================================

def verify_paystack_signature(raw_body: bytes, signature: str) -> bool:
    """
    Verify the HMAC-SHA512 signature of a Paystack webhook request.

    Paystack signs every webhook delivery with an HMAC-SHA512 hash of the
    raw request body using your PAYSTACK_WEBHOOK_SECRET as the key.
    The resulting hash is sent in the X-Paystack-Signature header.

    Args:
        raw_body: The raw bytes of the request body (NOT parsed JSON).
        signature: The X-Paystack-Signature header value.

    Returns:
        True if the signature is valid, False otherwise.

    Security Notes:
        - Uses hmac.compare_digest() to prevent timing attacks.
        - The secret key is read from environment, never hardcoded.
    """
    settings = get_settings()
    secret = settings.PAYSTACK_WEBHOOK_SECRET

    if not secret:
        logger.error("paystack_webhook_secret_not_configured")
        return False

    # Compute HMAC-SHA512 of the raw body using the webhook secret
    expected_signature = hmac.new(
        key=secret.encode("utf-8"),
        msg=raw_body,
        digestmod=hashlib.sha512,
    ).hexdigest()

    # Constant-time comparison to prevent timing attacks
    is_valid = hmac.compare_digest(expected_signature, signature)

    if not is_valid:
        logger.warning(
            "paystack_signature_mismatch",
            expected_prefix=expected_signature[:16] + "...",
            received_prefix=signature[:16] + "...",
        )

    return is_valid


# =============================================================================
# Paystack Service Class (for future expansion)
# =============================================================================

class PaystackService:
    """
    Paystack payment gateway service.

    Currently handles webhook signature verification.
    Designed to be extended with:
        - Initialize transaction (for direct payment)
        - Verify transaction
        - Create virtual account (for dedicated NUBAN)
    """

    def __init__(self):
        settings = get_settings()
        self.secret_key = settings.PAYSTACK_SECRET_KEY
        self.base_url = "https://api.paystack.co"

    @staticmethod
    def verify_signature(raw_body: bytes, signature: str) -> bool:
        """Delegate to the module-level verification function."""
        return verify_paystack_signature(raw_body, signature)

    async def initialize_transaction(
        self,
        email: str,
        amount: int,
        reference: str,
        callback_url: str = "",
    ) -> dict:
        """
        Initialize a Paystack payment transaction.

        Args:
            email: Customer's email address.
            amount: Amount in kobo (₦100 = 10000 kobo).
            reference: Unique transaction reference.
            callback_url: URL to redirect after payment.

        Returns:
            Paystack API response with authorization_url.

        Note: This is a placeholder for future direct payment integration.
              Currently, funding is handled via webhooks from Paystack's
              Virtual Account feature.
        """
        import httpx

        headers = {
            "Authorization": f"Bearer {self.secret_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "email": email,
            "amount": amount,
            "reference": reference,
        }

        if callback_url:
            payload["callback_url"] = callback_url

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/transaction/initialize",
                json=payload,
                headers=headers,
            )

        response_data = response.json()

        if response.status_code == 200 and response_data.get("status"):
            logger.info(
                "paystack_transaction_initialized",
                reference=reference,
                authorization_url=response_data.get("data", {}).get("authorization_url"),
            )
            return response_data.get("data", {})
        else:
            logger.error(
                "paystack_transaction_init_failed",
                reference=reference,
                response=response_data,
            )
            raise Exception(
                f"Paystack initialization failed: {response_data.get('message', 'Unknown error')}"
            )
