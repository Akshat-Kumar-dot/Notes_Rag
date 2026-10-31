from __future__ import annotations

import io
import zipfile

import docx

from app.parsers.base import Page, ParseError, ParseResult

# A .docx is a zip. A few MB can unpack to gigabytes of XML (a "zip bomb"), and
# python-docx would load all of it into memory. Real documents unpack to a few
# times their size, so the sizes declared in the zip are checked first.
MAX_UNPACKED = 200 * 1024 * 1024
MAX_RATIO = 100


def _check_unpacked_size(data: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            unpacked = sum(i.file_size for i in z.infolist())
    except zipfile.BadZipFile:
        return   # not a zip at all; python-docx reports it below
    if unpacked > MAX_UNPACKED or unpacked > MAX_RATIO * max(len(data), 1):
        raise ParseError("This Word file expands to far more than its size. It can't be read safely.")


def parse(data: bytes) -> ParseResult:
    _check_unpacked_size(data)
    try:
        document = docx.Document(io.BytesIO(data))
    except Exception:
        # python-docx only handles the modern zip-based format. Legacy .doc is
        # a different binary format entirely and needs LibreOffice.
        raise ParseError(
            "This file couldn't be read. If it's an older .doc, save it as .docx first."
        ) from None

    blocks = [p.text.strip() for p in document.paragraphs if p.text.strip()]
    for table in document.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                blocks.append(" | ".join(cells))

    text = "\n\n".join(blocks)
    if not text:
        raise ParseError("This document has no readable text.")

    return ParseResult(
        text=text,
        pages=[Page(number=1, text=text)],
        page_count=1,
        pages_with_text=1,
        parser_name="python-docx",
        parser_version="1",
    )
