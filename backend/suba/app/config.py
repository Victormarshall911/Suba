"""
SUBA Backend — Application Configuration
==========================================
Reads environment variables from a .env file using Pydantic BaseSettings.
All sensitive values (DATABASE_URL, secrets) are loaded here and never logged.
"""

from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Central configuration class for the SUBA backend.
    All values are read from environment variables or a .env file.
    """

    # -------------------------------------------------------------------------
    # App
    # -------------------------------------------------------------------------
    APP_SECRET_KEY: str = "change-me-to-a-random-secret-string"
    APP_ENV: str = "development"
    CORS_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://localhost:8000",
    ]

    # -------------------------------------------------------------------------
    # Database — Supabase PostgreSQL via asyncpg
    # SECURITY: This value is NEVER logged anywhere in the application.
    # -------------------------------------------------------------------------
    DATABASE_URL: str = "postgresql+asyncpg://user:password@host:5432/suba_db"

    # -------------------------------------------------------------------------
    # JWT Authentication
    # -------------------------------------------------------------------------
    JWT_SECRET_KEY: str = "change-me-to-a-strong-jwt-secret"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    # -------------------------------------------------------------------------
    # Paystack Payment Gateway
    # -------------------------------------------------------------------------
    PAYSTACK_SECRET_KEY: str = ""
    PAYSTACK_WEBHOOK_SECRET: str = ""

    # -------------------------------------------------------------------------
    # VTU Provider Configuration
    # -------------------------------------------------------------------------
    VTU_PROVIDER: str = "mock"  # options: mock | vtpass | smeplug
    VTU_API_KEY: str = ""
    VTU_BASE_URL: str = ""

    # -------------------------------------------------------------------------
    # Firebase (Phone Authentication)
    # -------------------------------------------------------------------------
    FIREBASE_CREDENTIALS_PATH: str = "firebase-credentials.json"

    # -------------------------------------------------------------------------
    # Validators
    # -------------------------------------------------------------------------
    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: object) -> List[str]:
        """Parse CORS_ORIGINS from a comma-separated string or list."""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        if isinstance(v, list):
            return v
        raise ValueError("CORS_ORIGINS must be a comma-separated string or a list")

    @field_validator("VTU_PROVIDER", mode="before")
    @classmethod
    def validate_vtu_provider(cls, v: str) -> str:
        """Ensure VTU_PROVIDER is one of the supported values."""
        allowed = {"mock", "vtpass", "smeplug"}
        if v.lower() not in allowed:
            raise ValueError(f"VTU_PROVIDER must be one of: {allowed}")
        return v.lower()

    # -------------------------------------------------------------------------
    # Pydantic Settings Config
    # -------------------------------------------------------------------------
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )


@lru_cache()
def get_settings() -> Settings:
    """
    Cached singleton for application settings.
    Call this function wherever settings are needed — it reads from
    the environment only once and caches the result.
    """
    return Settings()
