"""
SUBA Backend — VTU Service (Provider Abstraction Layer)
=========================================================
Implements the Strategy Pattern for VTU (Virtual Top-Up) providers.

Architecture:
    BaseVTUProvider (ABC)
        ├── MockVTUProvider    — Simulates 90% success / 10% failure for testing
        ├── VTpassProvider     — Real HTTP integration with VTpass API
        └── SmeplugProvider    — Real HTTP integration with SmePlug API

The active provider is selected at runtime via the VTU_PROVIDER env var.
This abstraction allows swapping providers without changing any router or
service code — only the .env file needs to change.

Usage:
    provider = get_vtu_provider()
    result = await provider.purchase_data(plan_code, phone, reference)
"""

import random
import uuid
from abc import ABC, abstractmethod
from typing import Dict

import httpx
import structlog

from app.config import get_settings

logger = structlog.get_logger()


# =============================================================================
# Abstract Base Provider
# =============================================================================

class BaseVTUProvider(ABC):
    """
    Abstract base class defining the contract for all VTU providers.

    Any new provider (VTpass, SmePlug, etc.) must implement this interface.
    """

    @abstractmethod
    async def purchase_data(
        self,
        plan_code: str,
        phone: str,
        reference: str,
    ) -> Dict:
        """
        Execute a data purchase on the VTU provider's platform.

        Args:
            plan_code: The plan identifier (e.g. 'm1', 'mtn-500mb').
            phone: The recipient phone number in Nigerian format.
            reference: A unique transaction reference for idempotency.

        Returns:
            A dictionary containing the provider's response data.
            Must include at minimum:
                - "success": bool
                - "message": str
                - "provider_reference": str (if available)

        Raises:
            Exception: On network errors, timeouts, or provider-side failures.
        """
        ...


# =============================================================================
# Mock Provider — For Development & Testing
# =============================================================================

class MockVTUProvider(BaseVTUProvider):
    """
    Mock VTU provider that simulates data purchases with a configurable
    success rate. Used for development and testing.

    Success rate: 90% success, 10% failure (simulates real-world reliability).
    """

    SUCCESS_RATE = 0.9  # 90% success probability

    async def purchase_data(
        self,
        plan_code: str,
        phone: str,
        reference: str,
    ) -> Dict:
        """
        Simulate a data purchase with randomized success/failure.

        The mock provider introduces no network delay — it returns
        immediately with a simulated response.
        """
        logger.info(
            "mock_vtu_purchase_attempt",
            plan_code=plan_code,
            phone=phone,
            reference=reference,
        )

        # Simulate success/failure based on configured probability
        if random.random() < self.SUCCESS_RATE:
            logger.info(
                "mock_vtu_purchase_success",
                reference=reference,
            )
            return {
                "success": True,
                "message": "Data bundle delivered successfully (MOCK)",
                "provider_reference": f"MOCK-{uuid.uuid4().hex[:8].upper()}",
                "plan_code": plan_code,
                "phone": phone,
            }
        else:
            logger.warning(
                "mock_vtu_purchase_failed",
                reference=reference,
            )
            raise Exception(
                f"Mock VTU provider simulated failure for reference {reference}"
            )


# =============================================================================
# VTpass Provider — Real Integration
# =============================================================================

class VTpassProvider(BaseVTUProvider):
    """
    VTpass VTU provider integration.

    Reads VTU_API_KEY and VTU_BASE_URL from environment configuration.
    Makes real HTTP calls to the VTpass API using httpx async client.

    VTpass API Docs: https://www.vtpass.com/documentation/
    """

    def __init__(self):
        settings = get_settings()
        self.api_key = settings.VTU_API_KEY
        self.base_url = settings.VTU_BASE_URL or "https://api-service.vtpass.com/api"

    async def purchase_data(
        self,
        plan_code: str,
        phone: str,
        reference: str,
    ) -> Dict:
        """
        Execute a real data purchase via the VTpass API.

        Endpoint: POST {base_url}/pay
        Headers: Authorization: Basic {api_key}
        Body: {
            "request_id": reference,
            "serviceID": "mtn-data" (derived from plan),
            "billersCode": phone,
            "variation_code": plan_code,
            "phone": phone
        }
        """
        logger.info(
            "vtpass_purchase_attempt",
            plan_code=plan_code,
            phone=phone,
            reference=reference,
        )

        headers = {
            "Authorization": f"Basic {self.api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "request_id": reference,
            "serviceID": plan_code.split("-")[0] + "-data" if "-" in plan_code else "mtn-data",
            "billersCode": phone,
            "variation_code": plan_code,
            "phone": phone,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/pay",
                json=payload,
                headers=headers,
            )

        response_data = response.json()

        # VTpass returns "code": "000" for success
        if response.status_code == 200 and response_data.get("code") == "000":
            logger.info(
                "vtpass_purchase_success",
                reference=reference,
                provider_response=response_data,
            )
            return {
                "success": True,
                "message": response_data.get("response_description", "Success"),
                "provider_reference": response_data.get("requestId", ""),
                "raw": response_data,
            }
        else:
            logger.error(
                "vtpass_purchase_failed",
                reference=reference,
                status_code=response.status_code,
                provider_response=response_data,
            )
            raise Exception(
                f"VTpass purchase failed: {response_data.get('response_description', 'Unknown error')}"
            )


# =============================================================================
# SmePlug Provider — Real Integration
# =============================================================================

class SmeplugProvider(BaseVTUProvider):
    """
    SmePlug VTU provider integration.

    Reads VTU_API_KEY and VTU_BASE_URL from environment configuration.
    Makes real HTTP calls to the SmePlug API using httpx async client.
    """

    def __init__(self):
        settings = get_settings()
        self.api_key = settings.VTU_API_KEY
        self.base_url = settings.VTU_BASE_URL or "https://smeplug.ng/api/v1"

    async def purchase_data(
        self,
        plan_code: str,
        phone: str,
        reference: str,
    ) -> Dict:
        """
        Execute a real data purchase via the SmePlug API.

        Endpoint: POST {base_url}/data/purchase
        Headers: Authorization: Bearer {api_key}
        Body: {
            "network": 1 (MTN), 2 (GLO), 3 (9MOBILE), 4 (AIRTEL),
            "plan": plan_code,
            "phone": phone,
            "ref": reference
        }
        """
        logger.info(
            "smeplug_purchase_attempt",
            plan_code=plan_code,
            phone=phone,
            reference=reference,
        )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "plan": plan_code,
            "phone": phone,
            "ref": reference,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/data/purchase",
                json=payload,
                headers=headers,
            )

        response_data = response.json()

        if response.status_code == 200 and response_data.get("status") == "success":
            logger.info(
                "smeplug_purchase_success",
                reference=reference,
                provider_response=response_data,
            )
            return {
                "success": True,
                "message": response_data.get("message", "Success"),
                "provider_reference": response_data.get("reference", ""),
                "raw": response_data,
            }
        else:
            logger.error(
                "smeplug_purchase_failed",
                reference=reference,
                status_code=response.status_code,
                provider_response=response_data,
            )
            raise Exception(
                f"SmePlug purchase failed: {response_data.get('message', 'Unknown error')}"
            )


# =============================================================================
# Factory Function — Returns the active provider based on env var
# =============================================================================

def get_vtu_provider() -> BaseVTUProvider:
    """
    Factory function that returns the appropriate VTU provider instance
    based on the VTU_PROVIDER environment variable.

    Supported values:
        - "mock"    → MockVTUProvider (default, for development/testing)
        - "vtpass"  → VTpassProvider (production VTpass integration)
        - "smeplug" → SmeplugProvider (production SmePlug integration)

    Returns:
        An instance of BaseVTUProvider.

    Raises:
        ValueError: If VTU_PROVIDER is not a recognized value.
    """
    settings = get_settings()
    provider_name = settings.VTU_PROVIDER.lower()

    providers = {
        "mock": MockVTUProvider,
        "vtpass": VTpassProvider,
        "smeplug": SmeplugProvider,
    }

    provider_class = providers.get(provider_name)
    if provider_class is None:
        raise ValueError(
            f"Unknown VTU provider '{provider_name}'. "
            f"Supported: {', '.join(providers.keys())}"
        )

    logger.info("vtu_provider_initialized", provider=provider_name)
    return provider_class()
