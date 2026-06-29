"""The effect bundle: the loop's only door to the outside world.

``Effects`` is a frozen bundle of four async callables. The orchestrator depends
on this interface, never on ``AgentRunner`` directly — so the entire loop can be
driven by fake effects in a test with zero network calls. ``live_effects`` wires
the bundle to real Anthropic-backed agents.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .client import AgentRunner
from .models import (
    CodeReview,
    ImplementationResult,
    OdysseusPlan,
    Task,
    TechDebtReport,
    ZeusPlan,
)
from .registry import AGENTS, implementer_for


@dataclass(frozen=True)
class Effects:
    """Injectable effectful steps. Pure code depends on this, not on the SDK.

    The agent path is: ``plan`` (Zeus) → ``orchestrate`` (Odysseus) →
    ``implement`` (parallel) → ``review`` ∥ ``audit`` → fixers (``implement``).
    """

    plan: Callable[[str], Awaitable[ZeusPlan]]
    orchestrate: Callable[[str, ZeusPlan], Awaitable[OdysseusPlan]]
    implement: Callable[[Task], Awaitable[ImplementationResult]]
    review: Callable[[tuple[str, ...]], Awaitable[CodeReview]]
    audit: Callable[[tuple[str, ...]], Awaitable[TechDebtReport]]


def _summary_of(parsed: dict) -> str:
    """Best-effort one-line summary across the implementers' differing schemas."""
    for key in ("summary", "issue_summary", "refactor_summary"):
        value = parsed.get(key)
        if isinstance(value, str) and value:
            return value
    return "(no summary provided)"


def _orchestrate_prompt(spec_text: str, plan: ZeusPlan) -> str:
    """Hand Odysseus the spec and Zeus's plan; ask for the planning output."""
    return (
        "## Feature specification\n"
        f"{spec_text}\n\n"
        "## Architectural plan from Zeus\n"
        "```json\n"
        f"{json.dumps(plan.model_dump(mode='json'), indent=2)}\n"
        "```\n\n"
        "Produce ONLY your Initial Planning Output JSON object (spec_summary, "
        "primitives, dependency_graph, slices, blocking_issues). Decompose the "
        "work into minimal, independently mergeable slices with explicit "
        "dependencies so they can be implemented in dependency order."
    )


def _review_prompt(files: tuple[str, ...]) -> str:
    listing = "\n".join(f"- {f}" for f in files) or "- (no files were changed)"
    return (
        "The following files were just created or modified by the implementation "
        "agents:\n"
        f"{listing}\n\n"
        "Review them exhaustively per your instructions. Use read_file and grep to "
        "inspect the current contents and any code they touch, then return your "
        "JSON verdict."
    )


def live_effects(runner: AgentRunner) -> Effects:
    """Bind the four effects to real agents driven by ``runner``."""

    async def plan(spec_text: str) -> ZeusPlan:
        run = await runner.run(AGENTS["zeus"], spec_text)
        return ZeusPlan.model_validate(run.parsed)

    async def orchestrate(spec_text: str, zeus_plan: ZeusPlan) -> OdysseusPlan:
        run = await runner.run(AGENTS["odysseus"], _orchestrate_prompt(spec_text, zeus_plan))
        return OdysseusPlan.model_validate(run.parsed)

    async def implement(task: Task) -> ImplementationResult:
        agent = implementer_for(task.kind)
        try:
            run = await runner.run(agent, task.spec)
        except Exception as exc:  # noqa: BLE001 - record failure, keep the loop alive
            return ImplementationResult(
                task_id=task.id, agent=agent.name, summary="", error=str(exc)
            )
        return ImplementationResult(
            task_id=task.id,
            agent=agent.name,
            summary=_summary_of(run.parsed),
            touched_files=run.touched_files,
            report=run.parsed,
        )

    async def review(files: tuple[str, ...]) -> CodeReview:
        run = await runner.run(AGENTS["athena"], _review_prompt(files))
        return CodeReview.model_validate(run.parsed)

    async def audit(files: tuple[str, ...]) -> TechDebtReport:
        run = await runner.run(AGENTS["hephaestus"], _review_prompt(files))
        return TechDebtReport.model_validate(run.parsed)

    return Effects(
        plan=plan,
        orchestrate=orchestrate,
        implement=implement,
        review=review,
        audit=audit,
    )
