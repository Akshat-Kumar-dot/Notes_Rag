"""guest trials and site-wide daily guest usage

Revision ID: 0003
Revises: 0002
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # Idempotent on purpose. Local dev and Render share one Neon database, so
    # these tables were created from a dev machine while production still ran
    # code whose head is 0002 -- and `alembic upgrade head` on boot fails when
    # the database is at a revision the deployed code has never heard of. The
    # database was therefore stamped back to 0002 with the tables in place;
    # this upgrade then only records 0003 when the new code deploys.
    if sa.inspect(op.get_bind()).has_table("guest_trials"):
        return

    op.create_table(
        "guest_trials",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # SET NULL, not CASCADE: the trial record must outlive the purged guest
        # account, or the same device could start a fresh trial every day.
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), unique=True),
        sa.Column("ip_hash", sa.String(64), nullable=False),
        sa.Column("device_hash", sa.String(64), nullable=False),
        sa.Column("fingerprint_hash", sa.String(64), nullable=False),
        sa.Column("uploads_used", sa.Integer, nullable=False, server_default="0"),
        sa.Column("messages_used", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_guest_trials_ip_created", "guest_trials", ["ip_hash", "created_at"])
    op.create_index("ix_guest_trials_device", "guest_trials", ["device_hash"])
    op.create_index("ix_guest_trials_fp_ip", "guest_trials", ["fingerprint_hash", "ip_hash"])

    op.create_table(
        "daily_usage",
        sa.Column("day", sa.Date, primary_key=True),
        sa.Column("kind", sa.String(32), primary_key=True),
        sa.Column("count", sa.Integer, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("daily_usage")
    op.drop_table("guest_trials")
