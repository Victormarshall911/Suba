"""Add referral_code and referred_by_id to users

Revision ID: 002
Revises: 001
Create Date: 2026-06-23

Adds referral tracking columns to the users table:
  - referral_code: Unique alphanumeric code used in share links
  - referred_by_id: FK to the user who referred this user (nullable)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add referral_code column (nullable for existing users)
    op.add_column(
        "users",
        sa.Column(
            "referral_code",
            sa.String(20),
            nullable=True,
            comment="Unique referral code assigned to this user",
        ),
    )
    op.create_unique_constraint(
        "uq_users_referral_code",
        "users",
        ["referral_code"],
    )
    op.create_index(
        "ix_users_referral_code",
        "users",
        ["referral_code"],
        unique=True,
    )

    # Add referred_by_id column (nullable)
    op.add_column(
        "users",
        sa.Column(
            "referred_by_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
            comment="Foreign key to the user who referred this account",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "referred_by_id")
    op.drop_index("ix_users_referral_code", table_name="users")
    op.drop_constraint("uq_users_referral_code", "users", type_="unique")
    op.drop_column("users", "referral_code")
