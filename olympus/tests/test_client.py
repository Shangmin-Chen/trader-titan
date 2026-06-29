"""Tests for the pure parts of the Claude Code shell.

The network-driven ``AgentRunner.run`` is exercised by the live smoke test, not
here; this file covers ``touched_paths``, which is pure and load-bearing (it is
how the loop learns what each implementer changed).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import olympus.client as client_mod
from olympus.client import AgentError, AgentRun, AgentRunner, touched_paths
from olympus.registry import Access, AgentSpec


def test_write_absolute_path_relativized(tmp_path):
    calls = [("Write", {"file_path": str(tmp_path / "pkg/mod.py"), "content": "x"})]
    assert touched_paths(calls, tmp_path) == ("pkg/mod.py",)


def test_write_relative_path_relativized(tmp_path):
    calls = [("Edit", {"file_path": "a.py", "old_string": "x", "new_string": "y"})]
    assert touched_paths(calls, tmp_path) == ("a.py",)


def test_read_and_grep_are_not_writes(tmp_path):
    calls = [("Read", {"file_path": str(tmp_path / "a.py")}), ("Grep", {"pattern": "x"})]
    assert touched_paths(calls, tmp_path) == ()


def test_notebook_edit_tracked_via_notebook_path(tmp_path):
    calls = [("NotebookEdit", {"notebook_path": str(tmp_path / "nb.ipynb")})]
    assert touched_paths(calls, tmp_path) == ("nb.ipynb",)


def test_write_outside_root_is_ignored(tmp_path):
    calls = [("Write", {"file_path": "/etc/passwd", "content": "x"})]
    assert touched_paths(calls, tmp_path) == ()


def test_missing_path_is_ignored(tmp_path):
    assert touched_paths([("Write", {"content": "x"})], tmp_path) == ()


def test_duplicate_writes_deduped_and_sorted(tmp_path):
    calls = [
        ("Write", {"file_path": "b.py", "content": "1"}),
        ("Edit", {"file_path": "b.py", "old_string": "1", "new_string": "2"}),
        ("Write", {"file_path": "a.py", "content": "1"}),
    ]
    assert touched_paths(calls, tmp_path) == ("a.py", "b.py")


def test_multiedit_tracked(tmp_path):
    calls = [("MultiEdit", {"file_path": "m.py", "edits": []})]
    assert touched_paths(calls, tmp_path) == ("m.py",)


def test_agent_run_is_frozen():
    run = AgentRun(parsed={"a": 1}, raw_text="{}", touched_files=("a.py",))
    with pytest.raises(ValidationError):
        run.raw_text = "changed"  # type: ignore[misc]
    assert run.raw_text == "{}"  # value is unchanged after the rejected mutation


def _tiny_spec(prompts_dir):
    (prompts_dir / "tiny.md").write_text("test agent", encoding="utf-8")
    return AgentSpec(
        name="tiny",
        role="test",
        model="claude-sonnet-4-6",
        thinking_budget=2048,
        prompt_file="tiny.md",
        access=Access.READ,
    )


class _StallStream:
    """A fake query stream that stalls forever and records whether it was closed."""

    def __init__(self) -> None:
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.sleep(60)
        raise StopAsyncIteration  # pragma: no cover

    async def aclose(self):
        self.closed = True


def test_run_times_out_and_closes_the_stream(tmp_path, monkeypatch):
    """A stalled CLI surfaces as AgentError AND the generator is closed (C1/C2)."""
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    stream = _StallStream()
    monkeypatch.setattr(client_mod, "query", lambda **_kwargs: stream)
    runner = AgentRunner(tmp_path, prompts, timeout_seconds=0.05)

    with pytest.raises(AgentError, match="timed out"):
        asyncio.run(runner.run(_tiny_spec(prompts), "do something"))
    assert stream.closed  # _drive's finally must aclose() the stream on timeout


def test_run_merges_touched_across_repair_retry(tmp_path, monkeypatch):
    """If the first attempt writes files then returns unparseable JSON, the repair
    retry's result must still credit the first attempt's writes (C2: no lost
    attribution). Tested at the run() level by faking the _drive boundary."""
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    runner = AgentRunner(tmp_path, prompts)
    calls = {"n": 0}

    async def _fake_drive(self, spec, user_prompt, touched):
        calls["n"] += 1
        if calls["n"] == 1:
            touched.add("a.py")  # wrote a file, then returns non-JSON
            return SimpleNamespace(result="sorry, here is the answer")
        touched.add("b.py")  # repair attempt writes another file, returns valid JSON
        return SimpleNamespace(result='{"done": true}')

    monkeypatch.setattr(AgentRunner, "_drive", _fake_drive)
    run = asyncio.run(runner.run(_tiny_spec(prompts), "do something"))

    assert run.parsed == {"done": True}
    assert run.touched_files == ("a.py", "b.py")  # both attempts credited
    assert calls["n"] == 2
