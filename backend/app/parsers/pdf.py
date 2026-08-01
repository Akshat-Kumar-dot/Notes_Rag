from __future__ import annotations

import fitz  # PyMuPDF

from app.parsers.base import Page, ParseError, ParseResult

# A page yielding less than this is treated as having no text layer -- almost
# always a scanned image, sometimes just a figure or a title page.
MIN_CHARS_PER_PAGE = 50


def parse(data: bytes) -> ParseResult:
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception:
        raise ParseError("This PDF couldn't be opened. It may be corrupt.") from None

    if doc.is_encrypted and not doc.authenticate(""):
        raise ParseError("This PDF is password-protected.")

    pages: list[Page] = []
    with_text = 0
    for i, page in enumerate(doc, start=1):
        try:
            text = page.get_text("text").strip()
        except Exception:
            text = ""
        if len(text) >= MIN_CHARS_PER_PAGE:
            with_text += 1
        pages.append(Page(number=i, text=text))

    count = doc.page_count
    doc.close()

    if with_text == 0:
        # Not a failure: the file is fine, it just has no text layer. Recorded
        # as coverage 0 so the UI can offer OCR later.
        raise ParseError(
            f"No readable text found in {count} page(s). "
            "This looks like a scanned document -- OCR isn't available yet."
        )

    return ParseResult(
        text="\n\n".join(p.text for p in pages if p.text),
        pages=pages,
        page_count=count,
        pages_with_text=with_text,
        parser_name="pymupdf",
        parser_version=fitz.VersionBind,
    )
