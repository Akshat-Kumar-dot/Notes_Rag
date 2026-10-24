import pytest

from app.api.study import _json
from app.llm.gemini import LLMError


def test_unwraps_an_object_inside_a_list():
    assert _json('[{"question": "Q?", "points": ["a"]}]') == {"question": "Q?", "points": ["a"]}


def test_finds_the_object_inside_prose():
    assert _json('Sure! {"score": 1} Hope that helps.') == {"score": 1}


@pytest.mark.parametrize("raw", ['["a", "b"]', "42", "[]", "no json here"])
def test_rejects_anything_that_is_not_an_object(raw):
    with pytest.raises(LLMError):
        _json(raw)
