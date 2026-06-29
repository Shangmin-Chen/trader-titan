"""Pure extraction of a JSON object from model output text.

Agents are instructed to "return ONLY valid JSON", but in practice may wrap it
in a ```json fence or surround it with a sentence of prose. ``extract_json``
recovers the outermost JSON object robustly and deterministically.
"""

from __future__ import annotations

import json


class JsonExtractionError(ValueError):
    """Raised when no parseable JSON object can be found in the text."""


def _strip_fences(text: str) -> str:
    """Remove a single leading ```json / ``` fence pair if present."""
    stripped = text.strip()
    if stripped.startswith("```"):
        first_newline = stripped.find("\n")
        if first_newline != -1:
            stripped = stripped[first_newline + 1 :]
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[: -len("```")]
    return stripped


def _outermost_object(text: str) -> str:
    """Return the substring from the first ``{`` to its matching ``}``.

    Brace matching is string-and-escape aware so braces inside JSON string
    literals do not throw off the depth count.
    """
    start = text.find("{")
    if start == -1:
        raise JsonExtractionError("no '{' found in model output")

    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise JsonExtractionError("unbalanced braces in model output")


def extract_json(text: str) -> dict:
    """Parse the outermost JSON object out of arbitrary model output.

    Tries, in order: the whole (fence-stripped) string, then the outermost
    brace-matched object. Raises ``JsonExtractionError`` on failure.
    """
    candidate = _strip_fences(text)
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        try:
            parsed = json.loads(_outermost_object(candidate))
        except json.JSONDecodeError as exc:
            raise JsonExtractionError(f"could not parse JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise JsonExtractionError(f"expected a JSON object, got {type(parsed).__name__}")
    return parsed
