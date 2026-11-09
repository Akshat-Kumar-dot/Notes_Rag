from app.study_store import cited_ranks


def test_only_cited_sources_count():
    assert cited_ranks("Paging avoids gaps [1]. TLBs cache entries [3].") == {1, 3}


def test_grouped_and_adjacent_citations():
    assert cited_ranks("Both hold [1, 2][4].") == {1, 2, 4}


def test_no_citations():
    assert cited_ranks("Your notes don't cover this.") == set()
    assert cited_ranks("") == set()
