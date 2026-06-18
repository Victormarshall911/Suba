"""
SUBA Backend — Custom HTTP Exceptions
========================================
Defines application-specific exception classes and a global exception handler
that ensures ALL error responses follow a consistent JSON shape:

    {
        "detail": "Human-readable error message",
        "code": "MACHINE_READABLE_ERROR_CODE"
    }

This module is imported in main.py to register the exception handlers.
"""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


# =============================================================================
# Custom Exception Classes
# =============================================================================

class SUBAException(HTTPException):
    """
    Base exception for all SUBA-specific HTTP errors.
    Subclasses set their own status_code and default detail/code.
    """

    def __init__(
        self,
        status_code: int = 500,
        detail: str = "An unexpected error occurred",
        code: str = "INTERNAL_ERROR",
    ):
        self.code = code
        super().__init__(status_code=status_code, detail=detail)


class InvalidCredentialsError(SUBAException):
    """Raised when login credentials (phone/password) are incorrect."""

    def __init__(self, detail: str = "Invalid phone number or password"):
        super().__init__(status_code=401, detail=detail, code="INVALID_CREDENTIALS")


class UnauthorizedError(SUBAException):
    """Raised when a request lacks valid authentication."""

    def __init__(self, detail: str = "Authentication required"):
        super().__init__(status_code=401, detail=detail, code="UNAUTHORIZED")


class ForbiddenError(SUBAException):
    """Raised when a user lacks permission for the requested action."""

    def __init__(self, detail: str = "You do not have permission to perform this action"):
        super().__init__(status_code=403, detail=detail, code="FORBIDDEN")


class NotFoundError(SUBAException):
    """Raised when a requested resource does not exist."""

    def __init__(self, detail: str = "Resource not found"):
        super().__init__(status_code=404, detail=detail, code="NOT_FOUND")


class ConflictError(SUBAException):
    """
    Raised when a resource conflict occurs.
    Used specifically for FOR UPDATE NOWAIT lock acquisition failures (HTTP 409).
    """

    def __init__(
        self,
        detail: str = "Another transaction is in progress for this wallet. Try again.",
    ):
        super().__init__(status_code=409, detail=detail, code="CONFLICT")


class InsufficientFundsError(SUBAException):
    """Raised when wallet balance is less than the requested purchase amount."""

    def __init__(self, detail: str = "Insufficient wallet balance"):
        super().__init__(status_code=402, detail=detail, code="INSUFFICIENT_FUNDS")


class PinNotSetError(SUBAException):
    """Raised when a user attempts a purchase without having set a wallet PIN."""

    def __init__(self, detail: str = "Transaction PIN not set. Please set your PIN first."):
        super().__init__(status_code=400, detail=detail, code="PIN_NOT_SET")


class InvalidPinError(SUBAException):
    """Raised when the provided wallet PIN does not match."""

    def __init__(self, detail: str = "Invalid transaction PIN"):
        super().__init__(status_code=400, detail=detail, code="INVALID_PIN")


class DuplicateResourceError(SUBAException):
    """Raised when attempting to create a resource that already exists."""

    def __init__(self, detail: str = "Resource already exists"):
        super().__init__(status_code=409, detail=detail, code="DUPLICATE")


class PurchaseFailedError(SUBAException):
    """
    Raised when a VTU purchase call fails.
    The wallet is automatically refunded before this error is returned.
    """

    def __init__(
        self,
        detail: str = "Purchase failed, wallet refunded",
    ):
        super().__init__(status_code=502, detail=detail, code="PURCHASE_FAILED")


class PaystackSignatureError(SUBAException):
    """Raised when Paystack webhook signature verification fails."""

    def __init__(self, detail: str = "Invalid webhook signature"):
        super().__init__(status_code=400, detail=detail, code="INVALID_SIGNATURE")


# =============================================================================
# Global Exception Handler — ensures consistent JSON error shape
# =============================================================================

async def suba_exception_handler(request: Request, exc: SUBAException) -> JSONResponse:
    """
    Global handler for all SUBAException subclasses.
    Returns a consistent JSON body with 'detail' and 'code' keys.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.detail,
            "code": exc.code,
        },
    )


async def generic_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Catch-all handler for unexpected exceptions.
    Logs the error and returns a generic 500 response.
    """
    # In production, this should log to a monitoring service
    import structlog
    logger = structlog.get_logger()
    logger.error("unhandled_exception", error=str(exc), path=request.url.path)

    return JSONResponse(
        status_code=500,
        content={
            "detail": "An unexpected error occurred",
            "code": "INTERNAL_ERROR",
        },
    )
