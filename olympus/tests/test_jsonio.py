"""Unit tests for robust JSON extraction from model output."""

from __future__ import annotations

import pytest

from olympus.jsonio import JsonExtractionError, extract_json


def test_plain_object():
    assert extract_json('{"a": 1}') == {"a": 1}


def test_json_fence():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_bare_fence():
    assert extract_json('```\n{"a": 1}\n```') == {"a": 1}


def test_prose_wrapped():
    text = 'Here is my verdict:\n{"verdict": "ok"}\nLet me know if you need more.'
    assert extract_json(text) == {"verdict": "ok"}


def test_braces_inside_strings_do_not_confuse_matcher():
    assert extract_json('{"note": "use {curly} braces"}') == {"note": "use {curly} braces"}


def test_nested_objects():
    assert extract_json('prefix {"a": {"b": [1, 2]}} suffix') == {"a": {"b": [1, 2]}}


def test_escaped_quote_in_string():
    assert extract_json(r'{"q": "a \" b"}') == {"q": 'a " b'}


def test_non_object_rejected():
    with pytest.raises(JsonExtractionError):
        extract_json("[1, 2, 3]")


def test_garbage_rejected():
    with pytest.raises(JsonExtractionError):
        extract_json("no json here at all")


def test_empty_and_whitespace_rejected():
    with pytest.raises(JsonExtractionError):
        extract_json("")
    with pytest.raises(JsonExtractionError):
        extract_json("   \n  ")


def test_first_object_wins_when_multiple():
    assert extract_json('{"a": 1} and then {"b": 2}') == {"a": 1}


def test_unbalanced_braces_rejected():
    with pytest.raises(JsonExtractionError):
        extract_json('{"a": 1')  # missing closing brace


def test_brace_in_string_does_not_terminate_early():
    # a closing brace inside a string must not end the object prematurely.
    assert extract_json('{"a": "}", "b": 2}') == {"a": "}", "b": 2}


def test_fenced_with_surrounding_prose():
    text = 'Sure!\n```json\n{"ok": true}\n```\nDone.'
    assert extract_json(text) == {"ok": True}


def test_array_of_objects_nested():
    assert extract_json('{"xs": [{"n": 1}, {"n": 2}]}') == {"xs": [{"n": 1}, {"n": 2}]}


def test_trailing_comma_is_invalid():
    with pytest.raises(JsonExtractionError):
        extract_json('{"a": 1,}')
