from __future__ import annotations

import io

from app.parsers.base import Page, ParseError, ParseResult

MIN_CHARS = 20


def parse(data: bytes) -> ParseResult:
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        raise ParseError("Image text extraction isn't available on this server.") from None

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        raise ParseError("This image couldn't be opened.") from None

    try:
        text = pytesseract.image_to_string(image).strip()
    except Exception:
        # The tesseract binary is a system package, separate from the python
        # wrapper. On a slim container it is often simply absent.
        raise ParseError("Image text extraction isn't available on this server.") from None

    if len(text) < MIN_CHARS:
        raise ParseError("No readable text found in this image.")

    return ParseResult(
        text=text,
        pages=[Page(number=1, text=text)],
        page_count=1,
        pages_with_text=1,
        parser_name="tesseract",
        parser_version="1",
    )
