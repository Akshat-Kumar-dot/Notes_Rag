import re

import pytest

from app.rag.retrieval import _SQL


@pytest.mark.parametrize("cte", ["dense", "sparse"])
def test_candidate_lists_keep_the_top_ranked_rows(cte):
    # LIMIT without its own ORDER BY keeps an arbitrary subset of the matches.
    body = re.search(rf"{cte} AS \((.*?)\n\),", _SQL.text, re.S).group(1)
    where = body[body.index("WHERE"):]
    assert "ORDER BY" in where
    assert where.index("ORDER BY") < where.index("LIMIT")
