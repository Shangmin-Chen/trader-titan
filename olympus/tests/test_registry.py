"""Tests for the agent roster: completeness, routing, and prompt wiring."""

from __future__ import annotations

from pathlib import Path

import pytest

from olympus.models import TaskKind
from olympus.registry import AGENTS, Access, implementer_for

_PROMPTS = Path(__file__).resolve().parents[2] / "prompts"


def test_full_pantheon_present():
    assert set(AGENTS) == {
        "zeus",
        "odysseus",
        "athena",
        "hephaestus",
        "daedalus",
        "chiron",
        "prometheus",
    }


def test_every_agent_prompt_file_exists():
    for key, spec in AGENTS.items():
        assert (_PROMPTS / spec.prompt_file).is_file(), f"{key}: {spec.prompt_file}"


def test_planners_use_opus_implementers_use_sonnet():
    assert AGENTS["zeus"].model == "claude-opus-4-8"
    assert AGENTS["odysseus"].model == "claude-opus-4-8"
    assert AGENTS["daedalus"].model == "claude-sonnet-4-6"


def test_thinking_budgets_mirror_subagent_configs():
    assert AGENTS["zeus"].thinking_budget == 1_000_000
    assert AGENTS["athena"].thinking_budget == 250_000


@pytest.mark.parametrize(
    "kind,expected",
    [
        (TaskKind.FEATURE, "daedalus-feature-implementation"),
        (TaskKind.FIX, "chiron-fix-implementation"),
        (TaskKind.REFACTOR, "prometheus-refactoring"),
    ],
)
def test_implementer_routing(kind, expected):
    assert implementer_for(kind).name == expected


def test_planners_and_reviewers_are_read_only():
    for key in ("zeus", "odysseus", "athena", "hephaestus"):
        assert AGENTS[key].access is Access.READ


def test_implementers_have_write_access():
    for key in ("daedalus", "chiron", "prometheus"):
        assert AGENTS[key].access is Access.WRITE


def test_system_prompt_loads_nonempty():
    text = AGENTS["athena"].system_prompt(_PROMPTS)
    assert "Athena" in text and len(text) > 500
