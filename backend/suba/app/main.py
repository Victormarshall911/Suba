"""
SUBA Backend — FastAPI Application Entrypoint
================================================
This is the main application file that:
    1. Creates the FastAPI app instance
    2. Configures CORS middleware for frontend access
    3. Registers all API routers
    4. Sets up global exception handlers
    5. Configures structured logging (JSON format)
    6. Adds rate limiting via slowapi
    7. Exposes the /health endpoint (no auth)

Run with:
    uvicorn app.main:app --reload --port 8000
"""

from datetime import datetime, timezone

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import get_settings
from app.core.exceptions import (
    SUBAException,
    generic_exception_handler,
    suba_exception_handler,
)
from app.routers import auth, purchase, wallet, webhooks


# =============================================================================
# Structured Logging Configuration
# =============================================================================

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer()
        if get_settings().APP_ENV == "development"
        else structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(0),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


# =============================================================================
# Rate Limiter Instance
# =============================================================================

limiter = Limiter(key_func=get_remote_address)


# =============================================================================
# FastAPI Application Instance
# =============================================================================

app = FastAPI(
    title="SUBA — Automated VTU & Data Bundle Platform",
    description=(
        "Production-ready REST API for SUBA — an automated Virtual Top-Up (VTU) "
        "and data bundle platform for Nigerian students. Features wallet management, "
        "JWT authentication, Paystack payment integration, and multi-provider VTU support."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# Attach rate limiter to the app state (required by slowapi)
app.state.limiter = limiter


# =============================================================================
# CORS Middleware — allows requests from the frontend origin
# =============================================================================

settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger.info(
    "cors_configured",
    origins=settings.CORS_ORIGINS,
)


# =============================================================================
# Exception Handlers
# =============================================================================

# Handle all SUBA-specific exceptions with consistent JSON shape
app.add_exception_handler(SUBAException, suba_exception_handler)

# Handle rate limit exceeded errors
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Catch-all for unexpected exceptions
app.add_exception_handler(Exception, generic_exception_handler)


# =============================================================================
# Router Registration
# =============================================================================

app.include_router(auth.router)
app.include_router(wallet.router)
app.include_router(purchase.router)
app.include_router(webhooks.router)

logger.info("routers_registered", routers=["auth", "wallet", "purchase", "webhooks"])


# =============================================================================
# Health Check Endpoint (No Auth Required)
# =============================================================================

@app.get(
    "/health",
    tags=["System"],
    summary="Health check",
    description="Returns the application health status. No authentication required.",
)
async def health_check() -> dict:
    """
    Simple health check endpoint.
    Returns 200 with status and current timestamp.
    """
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# =============================================================================
# Startup Event
# =============================================================================

@app.on_event("startup")
async def on_startup():
    """Log application startup details."""
    logger.info(
        "app_started",
        environment=settings.APP_ENV,
        vtu_provider=settings.VTU_PROVIDER,
    )


@app.on_event("shutdown")
async def on_shutdown():
    """Log application shutdown."""
    logger.info("app_shutdown")
