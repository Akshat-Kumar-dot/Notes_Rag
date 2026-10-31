from __future__ import annotations

import io

from app.parsers.base import Page, ParseError, ParseResult

MIN_CHARS = 20
# A small, highly compressible file can declare a huge canvas: 20,000 x 20,000
# pixels is ~1.2GB once decoded, more than the whole server has. Checked from
# the header, before any pixels are decoded. 40MP covers any phone photo.
MAX_PIXELS = 40_000_000


def parse(data: bytes) -> ParseResult:
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        raise ParseError("Image text extraction isn't available on this server.") from None

    try:
        image = Image.open(io.BytesIO(data))
    except Exception:
        raise ParseError("This image couldn't be opened.") from None
    width, height = image.size
    if width * height > MAX_PIXELS:
        raise ParseError("This image is too large to read. Resize it below 40 megapixels.")
    try:
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
