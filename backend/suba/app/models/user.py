"""
SUBA Backend — User Model
===========================
Defines the `users` table using SQLAlchemy 2.x declarative ORM.

Columns:
    - id:            UUID primary key (auto-generated)
    - email:         Unique, non-null email address
    - phone_number:  Unique, non-null Nigerian phone number (max 14 chars)
    - full_name:     User's full display name
    - password_hash: bcrypt-hashed password (NEVER returned in API responses)
    - role:          Enum — 'USER' or 'ADMIN', defaults to 'USER'
    - is_active:     Boolean flag for soft-disable, defaults to True
    - created_at:    Timestamp set at row creation
"""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Enum, String, Text, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class UserRole(str, enum.Enum):
    """Enumeration of user roles within the SUBA platform."""
    USER = "USER"
    ADMIN = "ADMIN"


class User(Base):
    """
    ORM model representing a registered SUBA user.
    Each user has exactly one wallet (created at registration).
    """

    __tablename__ = "users"

    # -------------------------------------------------------------------------
    # Primary Key
    # -------------------------------------------------------------------------
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        comment="Unique user identifier",
    )

    # -------------------------------------------------------------------------
    # Profile Fields
    # -------------------------------------------------------------------------
    email: Mapped[str] = mapped_column(
        String(255),
        unique=True,
        nullable=False,
        index=True,
        comment="User email address — must be unique",
    )

    phone_number: Mapped[str] = mapped_column(
        String(14),
        unique=True,
        nullable=False,
        index=True,
        comment="Nigerian phone number in format 0XXXXXXXXXX or +234XXXXXXXXXX",
    )

    full_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        comment="User's full display name",
    )

    # -------------------------------------------------------------------------
    # Security
    # -------------------------------------------------------------------------
    password_hash: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="bcrypt-hashed password — NEVER exposed via API",
    )

    # -------------------------------------------------------------------------
    # Role & Status
    # -------------------------------------------------------------------------
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role_enum", create_constraint=True),
        nullable=False,
        default=UserRole.USER,
        server_default="USER",
        comment="User role — USER or ADMIN",
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
        comment="Soft-disable flag — inactive users cannot log in",
    )

    # -------------------------------------------------------------------------
    # Timestamps
    # -------------------------------------------------------------------------
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        comment="Account creation timestamp",
    )

    # -------------------------------------------------------------------------
    # Relationships
    # -------------------------------------------------------------------------
    wallet: Mapped["Wallet"] = relationship(  # noqa: F821
        "Wallet",
        back_populates="user",
        uselist=False,
        lazy="selectin",
    )

    transactions: Mapped[list["Transaction"]] = relationship(  # noqa: F821
        "Transaction",
        back_populates="user",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<User id={self.id} email={self.email}>"
