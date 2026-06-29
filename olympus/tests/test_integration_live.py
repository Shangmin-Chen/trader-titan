"""Live integration test of the Claude Code shell — opt-in, hits the network.

Skipped unless OLYMPUS_LIVE=1, so the default suite stays hermetic. Run with:

    OLYMPUS_LIVE=1 .venv/bin/python -m pytest tests/test_integration_live.py -q

It proves the real driver end-to-end against the user's Claude Code session
(no ANTHROPIC_API_KEY): option assembly, the query/tool loop, result parsing,
and — critically — that file writes are tracked via tool interception.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from olympus.client import AgentRunner
from olympus.registry import Access, AgentSpec

_LIVE = os.environ.get("OLYMPUS_LIVE") == "1"
pytestmark = pytest.mark.skipif(not _LIVE, reason="set OLYMPUS_LIVE=1 to run live tests")

_TINY_PROMPT = (
    "You are a test agent. Do exactly what the user asks, then return ONLY a JSON "
    'object of the form {"done": true}. No prose, no fence.'
)


def _spec(prompts_dir, access=Access.WRITE):
    (prompts_dir / "tiny.md").write_text(_TINY_PROMPT, encoding="utf-8")
    return AgentSpec(
        name="tiny-test",
        role="test",
        model="claude-sonnet-4-6",
        thinking_budget=2048,
        prompt_file="tiny.md",
        access=access,
    )


def test_runner_writes_file_and_tracks_it(tmp_path):
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    runner = AgentRunner(tmp_path, prompts)
    spec = _spec(prompts)

    run = asyncio.run(
        runner.run(
            spec,
            "Create a file named hello.txt containing exactly the text 'hi'. "
            "Then return your JSON.",
        )
    )

    assert run.parsed == {"done": True}
    assert run.touched_files == ("hello.txt",)
    assert (tmp_path / "hello.txt").read_text().strip() == "hi"
