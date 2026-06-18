"""Create initial tables: users, wallets, transactions

Revision ID: 001
Revises: None
Create Date: 2026-06-17

This is the initial migration that creates all three core tables
for the SUBA VTU platform with their full constraints and indexes.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Create the users, wallets, and transactions tables with all
    constraints, indexes, and enum types.
    """

    # =========================================================================
    # Create ENUM types
    # =========================================================================
    user_role_enum = postgresql.ENUM(
        "USER", "ADMIN",
        name="user_role_enum",
        create_type=True,
    )
    transaction_type_enum = postgresql.ENUM(
        "FUNDING", "DATA_PURCHASE", "REFUND",
        name="transaction_type_enum",
        create_type=True,
    )
    transaction_status_enum = postgresql.ENUM(
        "PENDING", "SUCCESS", "FAILED",
        name="transaction_status_enum",
        create_type=True,
    )

    # Create enum types in the database
    user_role_enum.create(op.get_bind(), checkfirst=True)
    transaction_type_enum.create(op.get_bind(), checkfirst=True)
    transaction_status_enum.create(op.get_bind(), checkfirst=True)

    # =========================================================================
    # Table: users
    # =========================================================================
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), unique=True, nullable=False, index=True),
        sa.Column("phone_number", sa.String(14), unique=True, nullable=False, index=True),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column(
            "role",
            user_role_enum,
            nullable=False,
            server_default="USER",
        ),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # =========================================================================
    # Table: wallets
    # =========================================================================
    op.create_table(
        "wallets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "balance",
            sa.Numeric(12, 2),
            nullable=False,
            server_default="0.00",
        ),
        sa.Column("pin_hash", sa.Text, nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # Table-level constraints
        sa.CheckConstraint("balance >= 0", name="ck_wallets_balance_non_negative"),
        sa.UniqueConstraint("user_id", name="uq_wallets_user_id"),
    )

    # =========================================================================
    # Table: transactions
    # =========================================================================
    op.create_table(
        "transactions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "wallet_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("type", transaction_type_enum, nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column(
            "status",
            transaction_status_enum,
            nullable=False,
            server_default="PENDING",
        ),
        sa.Column("reference", sa.String(255), unique=True, nullable=False),
        sa.Column("recipient_phone", sa.String(14), nullable=True),
        sa.Column("network", sa.String(20), nullable=True),
        sa.Column("plan_code", sa.String(100), nullable=True),
        sa.Column("narration", sa.Text, nullable=True),
        sa.Column("provider_response", postgresql.JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # =========================================================================
    # Indexes for transactions
    # =========================================================================
    op.create_index(
        "ix_transactions_reference",
        "transactions",
        ["reference"],
        unique=True,
    )
    op.create_index(
        "ix_transactions_user_id",
        "transactions",
        ["user_id"],
    )
    op.create_index(
        "ix_transactions_created_at",
        "transactions",
        ["created_at"],
    )


def downgrade() -> None:
    """
    Drop all tables and enum types in reverse order.
    """
    # Drop tables (reverse order due to foreign keys)
    op.drop_table("transactions")
    op.drop_table("wallets")
    op.drop_table("users")

    # Drop enum types
    op.execute("DROP TYPE IF EXISTS transaction_status_enum")
    op.execute("DROP TYPE IF EXISTS transaction_type_enum")
    op.execute("DROP TYPE IF EXISTS user_role_enum")
