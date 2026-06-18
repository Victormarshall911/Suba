"""
SUBA Backend — Transaction Model
===================================
Defines the `transactions` table using SQLAlchemy 2.x declarative ORM.

Every financial event (funding, purchase, refund) is recorded as a transaction.
The `reference` column is UNIQUE and INDEXED for idempotency checks.

Columns:
    - id:                UUID primary key
    - user_id:           FK → users.id
    - wallet_id:         FK → wallets.id
    - type:              ENUM — FUNDING | DATA_PURCHASE | REFUND
    - amount:            NUMERIC(12,2) transaction amount in Naira
    - status:            ENUM — PENDING | SUCCESS | FAILED
    - reference:         UNIQUE indexed reference for idempotency
    - recipient_phone:   Nullable — populated for DATA_PURCHASE
    - network:           Nullable — e.g. MTN, AIRTEL, GLO, 9MOBILE
    - plan_code:         Nullable — VTU plan identifier
    - narration:         Nullable — human-readable description
    - provider_response: Nullable JSONB — raw response from VTU provider
    - created_at:        Timestamp at creation
    - updated_at:        Auto-updated timestamp
"""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Index, JSON, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class TransactionType(str, enum.Enum):
    """Enumeration of transaction types in the SUBA system."""
    FUNDING = "FUNDING"
    DATA_PURCHASE = "DATA_PURCHASE"
    REFUND = "REFUND"


class TransactionStatus(str, enum.Enum):
    """Enumeration of transaction statuses."""
    PENDING = "PENDING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"


class Transaction(Base):
    """
    ORM model representing a single financial transaction in the SUBA system.

    Every wallet debit, credit, or refund is recorded here. The `reference`
    field is used for idempotency — especially critical for webhook handling
    where Paystack may deliver the same event multiple times.
    """

    __tablename__ = "transactions"

    # -------------------------------------------------------------------------
    # Indexes
    # -------------------------------------------------------------------------
    __table_args__ = (
        Index("ix_transactions_reference", "reference", unique=True),
        Index("ix_transactions_user_id", "user_id"),
        Index("ix_transactions_created_at", "created_at"),
    )

    # -------------------------------------------------------------------------
    # Primary Key
    # -------------------------------------------------------------------------
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        comment="Unique transaction identifier",
    )

    # -------------------------------------------------------------------------
    # Foreign Keys
    # -------------------------------------------------------------------------
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        comment="User who initiated the transaction",
    )

    wallet_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("wallets.id", ondelete="CASCADE"),
        nullable=False,
        comment="Wallet involved in the transaction",
    )

    # -------------------------------------------------------------------------
    # Transaction Details
    # -------------------------------------------------------------------------
    type: Mapped[TransactionType] = mapped_column(
        Enum(TransactionType, name="transaction_type_enum", create_constraint=True),
        nullable=False,
        comment="Type of transaction: FUNDING, DATA_PURCHASE, or REFUND",
    )

    amount: Mapped[float] = mapped_column(
        Numeric(12, 2),
        nullable=False,
        comment="Transaction amount in Nigerian Naira (₦)",
    )

    status: Mapped[TransactionStatus] = mapped_column(
        Enum(TransactionStatus, name="transaction_status_enum", create_constraint=True),
        nullable=False,
        default=TransactionStatus.PENDING,
        server_default="PENDING",
        comment="Current status of the transaction",
    )

    reference: Mapped[str] = mapped_column(
        String(255),
        unique=True,
        nullable=False,
        comment="Unique reference for idempotency — indexed",
    )

    # -------------------------------------------------------------------------
    # VTU-Specific Fields (nullable — only for DATA_PURCHASE)
    # -------------------------------------------------------------------------
    recipient_phone: Mapped[str | None] = mapped_column(
        String(14),
        nullable=True,
        comment="Recipient phone number — populated for DATA_PURCHASE",
    )

    network: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
        comment="Mobile network: MTN, AIRTEL, GLO, or 9MOBILE",
    )

    plan_code: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
        comment="VTU plan identifier from the provider",
    )

    narration: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Human-readable transaction description",
    )

    provider_response: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
        comment="Raw JSON response from the VTU provider",
    )

    # -------------------------------------------------------------------------
    # Timestamps
    # -------------------------------------------------------------------------
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        comment="Transaction creation timestamp",
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        comment="Last modification timestamp — auto-updated",
    )

    # -------------------------------------------------------------------------
    # Relationships
    # -------------------------------------------------------------------------
    user: Mapped["User"] = relationship(  # noqa: F821
        "User",
        back_populates="transactions",
    )

    wallet: Mapped["Wallet"] = relationship(  # noqa: F821
        "Wallet",
        back_populates="transactions",
    )

    def __repr__(self) -> str:
        return (
            f"<Transaction id={self.id} type={self.type} "
            f"amount={self.amount} status={self.status}>"
        )
