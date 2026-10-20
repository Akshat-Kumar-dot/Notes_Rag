from __future__ import annotations

import codecs

from app.parsers.base import Page, ParseError, ParseResult

# Windows writes these too: Notepad's "UTF-8 with BOM" and "Unicode" (UTF-16),
# and PowerShell's `>`. UTF-32 BOMs are checked before UTF-16 because the
# UTF-32-LE mark starts with the UTF-16-LE one.
_BOMS = (
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)


def _decode(data: bytes) -> str:
    for bom, encoding in _BOMS:
        if data.startswith(bom):
            # These codecs strip the BOM. Left in, it hides a leading "# Title"
            # from the heading splitter.
            try:
                return data.decode(encoding)
            except UnicodeDecodeError:
                raise ParseError("This file isn't readable as text.") from None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        # Windows-authored .txt files are frequently cp1252, not utf-8.
        try:
            return data.decode("cp1252")
        except UnicodeDecodeError:
            raise ParseError("This file isn't readable as text.") from None


def parse(data: bytes) -> ParseResult:
    text = _decode(data)
    # NUL means the bytes were never text in that encoding (BOM-less UTF-16,
    # say). Postgres refuses to store it, which would fail the upload later with
    # a generic error instead of this one.
    if "\x00" in text:
        raise ParseError(
            "This file's text encoding isn't supported. Save it as UTF-8 and upload it again."
        )

    text = text.strip()
    if not text:
        raise ParseError("This file is empty.")

    return ParseResult(
        text=text,
        pages=[Page(number=1, text=text)],
        page_count=1,
        pages_with_text=1,
        parser_name="plaintext",
        parser_version="2",
    )
