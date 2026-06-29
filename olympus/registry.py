"""The agent roster.

Each ``AgentSpec`` mirrors a ``.claude/subagents/*.json`` config: the model, the
session-level thinking budget, the system-prompt file under ``prompts/``, and
whether the agent may write files. System-prompt text is loaded lazily from the
shared ``prompts/`` library so the prompt is authored once and reused here.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from .models import TaskKind


class Access(str, Enum):
    """Whether an agent gets write tools in addition to read tools."""

    READ = "read"
    WRITE = "write"


class AgentSpec(BaseModel):
    """Immutable description of one agent and how to invoke it."""

    model_config = ConfigDict(frozen=True)

    name: str
    role: str
    model: str
    # Session-level ceiling from the Claude Code config; clamped per-call by core.clamp_thinking.
    thinking_budget: int
    prompt_file: str
    access: Access

    def system_prompt(self, prompts_dir: Path) -> str:
        """Load this agent's system prompt from the shared prompts library."""
        return (prompts_dir / self.prompt_file).read_text(encoding="utf-8")


# Budgets mirror .claude/subagents/*.json: 1_000_000 for opus, 250_000 for sonnet.
_OPUS = "claude-opus-4-8"
_SONNET = "claude-sonnet-4-6"
_OPUS_BUDGET = 1_000_000
_SONNET_BUDGET = 250_000


AGENTS: dict[str, AgentSpec] = {
    "zeus": AgentSpec(
        name="zeus-planning",
        role="planner",
        model=_OPUS,
        thinking_budget=_OPUS_BUDGET,
        prompt_file="planning.md",
        access=Access.READ,
    ),
    "odysseus": AgentSpec(
        name="odysseus-orchestrator",
        role="orchestrator",
        model=_OPUS,
        thinking_budget=_OPUS_BUDGET,
        prompt_file="orchestrator.md",
        access=Access.READ,
    ),
    "athena": AgentSpec(
        name="athena-code-review",
        role="reviewer",
        model=_SONNET,
        thinking_budget=_SONNET_BUDGET,
        prompt_file="code-review.md",
        access=Access.READ,
    ),
    "hephaestus": AgentSpec(
        name="hephaestus-tech-debt",
        role="auditor",
        model=_SONNET,
        thinking_budget=_SONNET_BUDGET,
        prompt_file="tech-debt.md",
        access=Access.READ,
    ),
    "daedalus": AgentSpec(
        name="daedalus-feature-implementation",
        role="implementer",
        model=_SONNET,
        thinking_budget=_SONNET_BUDGET,
        prompt_file="feature-implementation.md",
        access=Access.WRITE,
    ),
    "chiron": AgentSpec(
        name="chiron-fix-implementation",
        role="implementer",
        model=_SONNET,
        thinking_budget=_SONNET_BUDGET,
        prompt_file="fix-implementation.md",
        access=Access.WRITE,
    ),
    "prometheus": AgentSpec(
        name="prometheus-refactoring",
        role="implementer",
        model=_SONNET,
        thinking_budget=_SONNET_BUDGET,
        prompt_file="refactoring.md",
        access=Access.WRITE,
    ),
}


# Which implementer handles each task kind.
_IMPLEMENTER_BY_KIND: dict[TaskKind, str] = {
    TaskKind.FEATURE: "daedalus",
    TaskKind.FIX: "chiron",
    TaskKind.REFACTOR: "prometheus",
}


def implementer_for(kind: TaskKind) -> AgentSpec:
    """Pure routing: pick the implementer agent for a task kind."""
    return AGENTS[_IMPLEMENTER_BY_KIND[kind]]
