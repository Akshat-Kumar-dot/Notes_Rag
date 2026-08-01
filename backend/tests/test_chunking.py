from app.parsers.base import Page
from app.rag.chunking import chunk_pages, count_tokens

MD = """# Traffic signal RL

Baseline is fixed-time control across the whole corridor.

## Reward shaping

Queue length penalty alone under-weights throughput badly.

```python
reward = -queue + 0.1 * throughput
```
"""


def _chunks(text: str, **kw):
    return chunk_pages([Page(number=1, text=text)], size=450, overlap=60, **kw)


def test_sections_split_on_headings():
    assert len(_chunks(MD)) >= 2


def test_heading_path_is_nested():
    paths = {c.heading for c in _chunks(MD)}
    assert "Traffic signal RL > Reward shaping" in paths


def test_heading_is_prepended_to_text():
    c = next(c for c in _chunks(MD) if c.heading and "Reward" in c.heading)
    assert c.text.startswith("Traffic signal RL > Reward shaping")


def test_short_section_under_a_heading_is_kept():
    """An aggressive min_tokens floor silently loses one-line answers."""
    out = _chunks("## Note\n\nDetector placement matters most.")
    assert len(out) == 1


def test_page_numbers_are_preserved():
    pages = [Page(number=1, text="First page content here."),
             Page(number=7, text="Seventh page content here.")]
    out = chunk_pages(pages, size=450, overlap=60)
    assert sorted({c.page_number for c in out}) == [1, 7]


def test_ordinals_are_contiguous():
    out = _chunks(MD)
    assert [c.ordinal for c in out] == list(range(len(out)))


def test_long_text_is_windowed_without_breaking_words():
    out = _chunks("# Big\n\n" + "lorem ipsum dolor sit amet " * 400)
    assert len(out) > 1
    assert all(not c.text.endswith(("lore", "ipsu", "dolo")) for c in out)


def test_token_count_is_stable_and_offline():
    assert count_tokens("hello world") > 0
    assert count_tokens("a b c d e") > count_tokens("a b")
