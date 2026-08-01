from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Table,
    Column,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.config import settings
from app.db import Base


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


# ----------------------------------------------------------------- auth


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # Partial index, not plain UNIQUE: guest users (later) have a NULL
        # google_sub, and any number of them must coexist.
        Index(
            "uq_users_google_sub", "google_sub", unique=True,
            postgresql_where=("google_sub IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = _pk()
    google_sub: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320))
    display_name: Mapped[str | None] = mapped_column(String(200))
    avatar_url: Mapped[str | None] = mapped_column(String(500))
    is_guest: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    sessions: Mapped[list[Session]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )


class Session(Base):
    """Cookie carries a random token; only its SHA-256 is stored, so a database
    leak hands nobody a usable session."""

    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_id", "user_id"),)

    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    user: Mapped[User] = relationship(back_populates="sessions")


# -------------------------------------------------------------- documents


class Folder(Base):
    __tablename__ = "folders"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_folders_user_name"),
        Index("ix_folders_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    files: Mapped[list[File]] = relationship(
        back_populates="folder", cascade="all, delete-orphan", passive_deletes=True
    )


class FileStatus(StrEnum):
    PENDING = "pending"
    PARSING = "parsing"
    INDEXED = "indexed"
    PARTIAL = "partial"   # parsed, but much of the file had no readable text
    FAILED = "failed"


class File(Base):
    """The uploaded binary is discarded once chunks are committed. Everything
    recorded here is one-way: it cannot be recomputed later."""

    __tablename__ = "files"
    __table_args__ = (
        UniqueConstraint("user_id", "sha256", name="uq_files_user_sha"),
        Index("ix_files_folder_created", "folder_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = _pk()
    folder_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    original_filename: Mapped[str] = mapped_column(String(400), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(150), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    status: Mapped[FileStatus] = mapped_column(
        String(16), default=FileStatus.PENDING, nullable=False
    )
    error: Mapped[str | None] = mapped_column(Text)

    # extraction quality -- captured now because the original is deleted
    page_count: Mapped[int | None] = mapped_column(Integer)
    pages_with_text: Mapped[int | None] = mapped_column(Integer)
    chars_extracted: Mapped[int | None] = mapped_column(Integer)
    coverage: Mapped[float | None] = mapped_column(Numeric(4, 3))
    parser_name: Mapped[str | None] = mapped_column(String(50))
    parser_version: Mapped[str | None] = mapped_column(String(30))
    original_retained: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    folder: Mapped[Folder] = relationship(back_populates="files")
    extracted: Mapped[FileText | None] = relationship(
        back_populates="file", cascade="all, delete-orphan", passive_deletes=True,
        uselist=False,
    )


class FileText(Base):
    """Extracted text, kept in its own table so listing files does not drag
    megabytes of prose through the connection. Survives re-embedding: if the
    embedding model ever changes, this is what saves you re-uploading."""

    __tablename__ = "file_texts"

    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)

    file: Mapped[File] = relationship(back_populates="extracted")


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (
        UniqueConstraint("file_id", "ordinal", name="uq_chunks_file_ordinal"),
        # (user_id, folder_id) is the hot filter on every query -- both are
        # denormalised off File so retrieval needs no joins.
        Index("ix_chunks_user_folder", "user_id", "folder_id"),
        Index("ix_chunks_tsv", "tsv", postgresql_using="gin"),
        Index(
            "ix_chunks_embedding", "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[uuid.UUID] = _pk()
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), nullable=False
    )
    folder_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    page_number: Mapped[int | None] = mapped_column(Integer)
    heading: Mapped[str | None] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(settings.embedding_dim), nullable=False)
    tsv: Mapped[str | None] = mapped_column(TSVECTOR)  # maintained by DB trigger

    file: Mapped[File] = relationship()


# ----------------------------------------------------------- conversations

conversation_folders = Table(
    "conversation_folders",
    Base.metadata,
    Column("conversation_id", ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True),
    Column("folder_id", ForeignKey("folders.id", ondelete="CASCADE"), primary_key=True),
)


class Conversation(Base):
    """Folder scope is fixed at creation. If it could change mid-thread, older
    answers would become unexplainable."""

    __tablename__ = "conversations"
    __table_args__ = (Index("ix_conversations_user_updated", "user_id", "updated_at"),)

    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), default="New chat", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    folders: Mapped[list[Folder]] = relationship(secondary=conversation_folders)
    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan",
        passive_deletes=True, order_by="Message.created_at",
    )


class Role(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_conv_created", "conversation_id", "created_at"),)

    id: Mapped[uuid.UUID] = _pk()
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[Role] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    low_confidence: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    retrieval_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    conversation: Mapped[Conversation] = relationship(back_populates="messages")
    citations: Mapped[list[Citation]] = relationship(
        back_populates="message", cascade="all, delete-orphan",
        passive_deletes=True, order_by="Citation.rank",
    )


class Citation(Base):
    """Snapshots what it displayed. Delete the source folder and old answers stay
    readable -- chunk_id just goes NULL, which the UI reads as 'source removed'."""

    __tablename__ = "citations"
    __table_args__ = (UniqueConstraint("message_id", "rank", name="uq_citations_msg_rank"),)

    id: Mapped[uuid.UUID] = _pk()
    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    chunk_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("chunks.id", ondelete="SET NULL")
    )
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    score: Mapped[float | None] = mapped_column(Float)
    excerpt_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    source_label: Mapped[str] = mapped_column(String(400), nullable=False)

    message: Mapped[Message] = relationship(back_populates="citations")
