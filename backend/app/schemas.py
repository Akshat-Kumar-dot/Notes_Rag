from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UserOut(ORM):
    id: UUID
    email: str | None
    display_name: str | None
    avatar_url: str | None
    is_guest: bool


# --- folders ---
class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def clean(cls, v: str) -> str:
        v = " ".join(v.split())   # collapse whitespace, strip ends
        if not v:
            raise ValueError("Name can't be blank.")
        return v


class FolderOut(BaseModel):
    id: UUID
    name: str
    created_at: datetime
    file_count: int
    size_bytes: int = 0


class StorageOut(BaseModel):
    used_bytes: int
    limit_bytes: int
    file_count: int
    folder_count: int


# --- files ---
class FileOut(ORM):
    id: UUID
    folder_id: UUID
    original_filename: str
    mime_type: str
    size_bytes: int
    status: str
    error: str | None
    page_count: int | None
    pages_with_text: int | None
    coverage: float | None
    chunk_count: int
    created_at: datetime

    @property
    def pages_missing_text(self) -> int:
        if self.page_count is None or self.pages_with_text is None:
            return 0
        return self.page_count - self.pages_with_text


# --- search ---
class SearchHit(BaseModel):
    chunk_id: UUID
    file_id: UUID
    filename: str
    folder_name: str
    page_number: int | None
    heading: str | None
    text: str
    score: float


class SearchResponse(BaseModel):
    query: str
    results: list[SearchHit]
    low_confidence: bool
    elapsed_ms: int


# --- chat ---
class ConversationCreate(BaseModel):
    folder_ids: list[UUID] = Field(min_length=1)
    title: str | None = Field(default=None, max_length=200)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class CitationOut(ORM):
    rank: int
    score: float | None
    excerpt_snapshot: str
    source_label: str
    chunk_id: UUID | None   # NULL once the source file or folder is deleted


class MessageOut(ORM):
    id: UUID
    role: str
    content: str
    low_confidence: bool
    created_at: datetime
    citations: list[CitationOut] = []


class ConversationOut(BaseModel):
    id: UUID
    title: str
    created_at: datetime
    updated_at: datetime
    folder_ids: list[UUID]


class ConversationDetail(ConversationOut):
    messages: list[MessageOut] = []
