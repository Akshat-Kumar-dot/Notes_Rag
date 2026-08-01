from __future__ import annotations

from app.parsers.base import Page, ParseError, ParseResult


def parse(data: bytes) -> ParseResult:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        # Windows-authored .txt files are frequently cp1252, not utf-8.
        try:
            text = data.decode("cp1252")
        except UnicodeDecodeError:
            raise ParseError("This file isn't readable as text.") from None

    text = text.strip()
    if not text:
        raise ParseError("This file is empty.")

    return ParseResult(
        text=text,
        pages=[Page(number=1, text=text)],
        page_count=1,
        pages_with_text=1,
        parser_name="plaintext",
        parser_version="1",
    )
