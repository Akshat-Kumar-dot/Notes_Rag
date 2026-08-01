"""folders, files, chunks, conversations

Revision ID: 0002
Revises: 0001
"""
from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None

EMBED_DIM = 768


def upgrade() -> None:
    op.create_table(
        "folders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "name", name="uq_folders_user_name"),
    )
    op.create_index("ix_folders_user_created", "folders", ["user_id", "created_at"])

    op.create_table(
        "files",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("folder_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("folders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("original_filename", sa.String(400), nullable=False),
        sa.Column("mime_type", sa.String(150), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text),
        sa.Column("page_count", sa.Integer),
        sa.Column("pages_with_text", sa.Integer),
        sa.Column("chars_extracted", sa.Integer),
        sa.Column("coverage", sa.Numeric(4, 3)),
        sa.Column("parser_name", sa.String(50)),
        sa.Column("parser_version", sa.String(30)),
        sa.Column("original_retained", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("chunk_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("indexed_at", sa.DateTime(timezone=True)),
        # Same file twice costs nothing to reject and saves re-embedding it.
        sa.UniqueConstraint("user_id", "sha256", name="uq_files_user_sha"),
    )
    op.create_index("ix_files_folder_created", "files", ["folder_id", "created_at"])

    op.create_table(
        "file_texts",
        sa.Column("file_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("text", sa.Text, nullable=False),
    )

    op.create_table(
        "chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("folder_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("folders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ordinal", sa.Integer, nullable=False),
        sa.Column("page_number", sa.Integer),
        sa.Column("heading", sa.Text),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("token_count", sa.Integer, nullable=False),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(EMBED_DIM), nullable=False),
        sa.Column("tsv", postgresql.TSVECTOR),
        sa.UniqueConstraint("file_id", "ordinal", name="uq_chunks_file_ordinal"),
    )
    op.create_index("ix_chunks_user_folder", "chunks", ["user_id", "folder_id"])
    op.create_index("ix_chunks_tsv", "chunks", ["tsv"], postgresql_using="gin")
    # HNSW rather than IVFFlat: no training pass, so the index is usable while
    # files are still being uploaded.
    op.create_index(
        "ix_chunks_embedding", "chunks", ["embedding"],
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )

    # Lexical index maintained by the database, so it can never drift out of
    # sync with the text column.
    op.execute(
        """
        CREATE FUNCTION chunks_tsv_update() RETURNS trigger AS $$
        BEGIN
            NEW.tsv := to_tsvector('english', COALESCE(NEW.heading,'') || ' ' || NEW.text);
            RETURN NEW;
        END
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER chunks_tsv_trigger
        BEFORE INSERT OR UPDATE OF text, heading ON chunks
        FOR EACH ROW EXECUTE FUNCTION chunks_tsv_update();
        """
    )

    op.create_table(
        "conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False, server_default="New chat"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_conversations_user_updated", "conversations", ["user_id", "updated_at"])

    op.create_table(
        "conversation_folders",
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("folder_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("folders.id", ondelete="CASCADE"), primary_key=True),
    )

    op.create_table(
        "messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("low_confidence", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("retrieval_ms", sa.Integer),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_messages_conv_created", "messages", ["conversation_id", "created_at"])

    op.create_table(
        "citations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("message_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False),
        # SET NULL, not CASCADE: deleting a folder must not erase the citation
        # rows of answers already given. The snapshot keeps them readable.
        sa.Column("chunk_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("chunks.id", ondelete="SET NULL")),
        sa.Column("rank", sa.Integer, nullable=False),
        sa.Column("score", sa.Float),
        sa.Column("excerpt_snapshot", sa.Text, nullable=False),
        sa.Column("source_label", sa.String(400), nullable=False),
        sa.UniqueConstraint("message_id", "rank", name="uq_citations_msg_rank"),
    )


def downgrade() -> None:
    op.drop_table("citations")
    op.drop_table("messages")
    op.drop_table("conversation_folders")
    op.drop_table("conversations")
    op.execute("DROP TRIGGER IF EXISTS chunks_tsv_trigger ON chunks")
    op.execute("DROP FUNCTION IF EXISTS chunks_tsv_update()")
    op.drop_table("chunks")
    op.drop_table("file_texts")
    op.drop_table("files")
    op.drop_table("folders")
