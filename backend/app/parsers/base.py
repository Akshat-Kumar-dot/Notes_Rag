"""One interface for every format: bytes in, ParseResult out.

Adding a format is a new module plus one registry line -- nothing else in the
codebase knows how many formats exist.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass(slots=True)
class Page:
    number: int
    text: str


@dataclass(slots=True)
class ParseResult:
    text: str
    pages: list[Page] = field(default_factory=list)
    page_count: int = 1
    pages_with_text: int = 0
    parser_name: str = "unknown"
    parser_version: str = "0"

    @property
    def chars(self) -> int:
        return len(self.text)

    @property
    def coverage(self) -> float:
        """Fraction of pages that yielded readable text. A text-layer-free scan
        lands near 0.0 -- that is the signal for 'partial', and the reason to
        keep the original for later OCR."""
        if self.page_count <= 0:
            return 0.0
        return round(self.pages_with_text / self.page_count, 3)


class ParseError(Exception):
    """Raised for a file we cannot read at all. The message is shown to the user,
    so keep it plain."""


# MIME type -> parser. Populated by app.parsers.__init__ to avoid import cycles.
REGISTRY: dict[str, Callable[[bytes], ParseResult]] = {}

EXTENSION_MIME = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def parser_for(mime: str) -> Callable[[bytes], ParseResult]:
    fn = REGISTRY.get(mime)
    if fn is None:
        raise ParseError(f"{mime} files aren't supported yet.")
    return fn
