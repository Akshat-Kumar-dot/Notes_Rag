"""Registry wiring. Import failures are tolerated so a missing optional
dependency disables one format instead of breaking the whole app."""

import logging

from app.parsers.base import ParseError, ParseResult, parser_for  # noqa: F401
from app.parsers.base import REGISTRY

log = logging.getLogger(__name__)

from app.parsers import plaintext  # noqa: E402

REGISTRY["text/plain"] = plaintext.parse
REGISTRY["text/markdown"] = plaintext.parse

try:
    from app.parsers import pdf

    REGISTRY["application/pdf"] = pdf.parse
except ImportError:  # pragma: no cover
    log.warning("PyMuPDF unavailable - PDF uploads disabled")

try:
    from app.parsers import word

    REGISTRY[
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ] = word.parse
except ImportError:  # pragma: no cover
    log.warning("python-docx unavailable - Word uploads disabled")

try:
    from app.parsers import image

    for _m in ("image/png", "image/jpeg", "image/webp"):
        REGISTRY[_m] = image.parse
except ImportError:  # pragma: no cover
    log.warning("Pillow/pytesseract unavailable - image uploads disabled")

SUPPORTED_MIMES = frozenset(REGISTRY)
