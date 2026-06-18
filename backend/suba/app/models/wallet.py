"""
SUBA Backend — Wallet Model
==============================
Defines the `wallets` table using SQLAlchemy 2.x declarative ORM.

Each user has exactly ONE wallet (enforced by UNIQUE constraint on user_id).
The balance is stored as NUMERIC(12,2) in Naira with a CHECK >= 0 constraint.

Columns:
    - id:         UUID primary key (auto-generated)
    - user_id:    FK → users.id, UNIQUE (one wallet per user)
    - balance:    NUMERIC(12,2), default 0, CHECK >= 0
    - pin_hash:   Nullable bcrypt hash of 4-digit transaction PIN
    - updated_at: Auto-updated timestamp on every modification
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Numeric,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Wallet(Base):
    """
    ORM model representing a user's SUBA wallet.

    CRITICAL: Row-level locking via SELECT ... FOR UPDATE NOWAIT is used
    on this table during purchase transactions to prevent double-spend.
    """

    __tablename__ = "wallets"

    # -------------------------------------------------------------------------
    # Table-Level Constraints
    # -------------------------------------------------------------------------
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_wallets_user_id"),
        CheckConstraint("balance >= 0", name="ck_wallets_balance_non_negative"),
    )

    # -------------------------------------------------------------------------
    # Primary Key
    # -------------------------------------------------------------------------
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        comment="Unique wallet identifier",
    )

    # -------------------------------------------------------------------------
    # Foreign Key — One wallet per user
    # -------------------------------------------------------------------------
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        comment="Owner user ID — each user has exactly one wallet",
    )

    # -------------------------------------------------------------------------
    # Financial Fields
    # -------------------------------------------------------------------------
    balance: Mapped[float] = mapped_column(
        Numeric(12, 2),
        nullable=False,
        default=0.00,
        server_default="0.00",
        comment="Wallet balance in Nigerian Naira (₦) — CHECK >= 0",
    )

    # -------------------------------------------------------------------------
    # Security — Transaction PIN
    # -------------------------------------------------------------------------
    pin_hash: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        default=None,
        comment="bcrypt hash of 4-digit transaction PIN — set during onboarding",
    )

    # -------------------------------------------------------------------------
    # Timestamps
    # -------------------------------------------------------------------------
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
        back_populates="wallet",
    )

    transactions: Mapped[list["Transaction"]] = relationship(  # noqa: F821
        "Transaction",
        back_populates="wallet",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Wallet id={self.id} user_id={self.user_id} balance={self.balance}>"
