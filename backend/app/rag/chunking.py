"""Chunking that keeps headings attached to their content.

A fixed token window shreds a heading away from the text under it, which is the
most common cause of poor retrieval on notes. Markdown is split on headings
first; other formats fall back to paragraph packing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.parsers.base import Page

_HEADING = re.compile(r"^(#{1,6})\s+(.+)$")
_FENCE = re.compile(r"^```")
_WORD = re.compile(r"\w+|[^\w\s]")


def count_tokens(text: str) -> int:
    """Approximate token count.

    A real BPE tokenizer would need a runtime model download, and the obvious
    candidate (tiktoken/cl100k) is OpenAI's -- wrong for Gemini anyway, so its
    precision would be false comfort. Chunking only needs *consistent* sizing,
    not exact counts: words plus punctuation, scaled for subword splitting,
    lands within ~10% across normal prose and is stable offline.
    """
    return int(len(_WORD.findall(text)) * 1.3) + 1


@dataclass(slots=True)
class TextChunk:
    ordinal: int
    text: str
    token_count: int
    heading: str | None
    page_number: int | None


def _window(text: str, size: int, overlap: int) -> list[str]:
    """Split on whitespace so chunks never break mid-word."""
    if count_tokens(text) <= size:
        return [text]
    words = text.split()
    # size is in approximate tokens; convert to a word budget.
    per_chunk = max(int(size / 1.3), 1)
    step = max(per_chunk - int(overlap / 1.3), 1)
    out = []
    for start in range(0, len(words), step):
        piece = " ".join(words[start : start + per_chunk])
        if piece:
            out.append(piece)
        if start + per_chunk >= len(words):
            break
    return out


def _markdown_sections(text: str) -> list[tuple[str | None, str]]:
    stack: list[str] = []
    sections: list[tuple[str | None, str]] = []
    buf: list[str] = []
    heading: str | None = None
    in_fence = False

    for line in text.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
        match = None if in_fence else _HEADING.match(line)
        if match:
            if buf:
                sections.append((heading, "\n".join(buf).strip()))
                buf = []
            level, title = len(match.group(1)), match.group(2).strip()
            stack = stack[: level - 1]
            stack.append(title)
            heading = " > ".join(stack)
        else:
            buf.append(line)

    if buf:
        sections.append((heading, "\n".join(buf).strip()))
    return [(h, b) for h, b in sections if b]


def chunk_pages(
    pages: list[Page], *, size: int, overlap: int, min_tokens: int = 4
) -> list[TextChunk]:
    """Page-aware chunking, so citations can say which page an answer came from."""
    chunks: list[TextChunk] = []
    ordinal = 0
    for page in pages:
        if not page.text.strip():
            continue
        for heading, body in _markdown_sections(page.text) or [(None, page.text)]:
            for piece in _window(body, size, overlap):
                # Only drop genuinely empty fragments. A one-sentence section
                # under a heading is often the most precise answer in the file;
                # an aggressive floor here silently loses it.
                if count_tokens(piece) < min_tokens:
                    continue
                # Prepending the heading measurably helps dense retrieval: the
                # embedding then carries the structural context too.
                full = f"{heading}\n\n{piece}" if heading else piece
                chunks.append(
                    TextChunk(
                        ordinal=ordinal,
                        text=full,
                        token_count=count_tokens(full),
                        heading=heading,
                        page_number=page.number,
                    )
                )
                ordinal += 1
    return chunks
