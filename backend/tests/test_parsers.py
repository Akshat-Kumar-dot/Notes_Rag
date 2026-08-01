import io

import pytest

from app.parsers import plaintext, word
from app.parsers.base import ParseError


def test_utf8_text():
    r = plaintext.parse(b"# Title\n\nBody text.")
    assert r.coverage == 1.0 and r.chars > 0


def test_cp1252_fallback():
    """Windows-authored .txt files are frequently cp1252, not utf-8."""
    assert plaintext.parse("café — dash".encode("cp1252")).text == "café — dash"


def test_empty_file_rejected():
    with pytest.raises(ParseError):
        plaintext.parse(b"   \n  ")


def test_docx_paragraphs_and_tables():
    import docx

    d = docx.Document()
    d.add_paragraph("Queue length penalty under-weights throughput.")
    t = d.add_table(rows=1, cols=2)
    t.rows[0].cells[0].text = "col a"
    t.rows[0].cells[1].text = "col b"
    buf = io.BytesIO()
    d.save(buf)

    r = word.parse(buf.getvalue())
    assert "throughput" in r.text
    assert "col a | col b" in r.text


def test_legacy_doc_gives_actionable_error():
    with pytest.raises(ParseError, match="docx"):
        word.parse(b"\xd0\xcf\x11\xe0legacy-ole-header")
