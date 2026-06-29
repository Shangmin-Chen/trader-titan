"""Frozen, typed contracts for the orchestration loop.

Two layers live here, separated by the comment banners:

  * WIRE models  — parsed from agent JSON output. ``extra="ignore"`` so that
    additions to a prompt's output schema never break the loop; we model only
    the fields the loop reasons about.
  * DOMAIN models — Olympus's own internal types, fully owned by this package.

Every model is frozen. State transitions return new instances; nothing mutates.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


# --------------------------------------------------------------------------- #
# Enums                                                                        #
# --------------------------------------------------------------------------- #
class TaskKind(str, Enum):
    """Which implementer a task is routed to."""

    FEATURE = "feature"
    FIX = "fix"
    REFACTOR = "refactor"


class RunStatus(str, Enum):
    """Terminal status of an orchestration run."""

    PASSED = "passed"
    MAX_ITERATIONS = "max_iterations"
    NO_TASKS = "no_tasks"
    FAILED = "failed"
    # Not approved, but no actionable blockers were produced — the loop cannot
    # make progress by fixing, so it stops rather than spinning the budget.
    STALLED = "stalled"


class DecisionKind(str, Enum):
    """Whether the orchestration loop should stop or continue."""

    STOP = "stop"
    CONTINUE = "continue"


class _Frozen(BaseModel):
    """Base for Olympus-owned domain models: immutable, strict."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class _Wire(BaseModel):
    """Base for models parsed from agent output: immutable, lenient on extras."""

    model_config = ConfigDict(frozen=True, extra="ignore")


# --------------------------------------------------------------------------- #
# WIRE — parsed from agent JSON output                                         #
# --------------------------------------------------------------------------- #
class Finding(_Wire):
    """A single code-review finding (critical / major / minor)."""

    id: str = ""
    category: str = ""
    location: str = ""
    finding: str = ""
    impact: str = ""
    fix: str = ""


class JaneStreetStandard(_Wire):
    """Athena's explicit production-readiness verdict."""

    would_approve: bool = False
    blocking_reasons: tuple[str, ...] = ()
    commendations: tuple[str, ...] = ()


class CodeReview(_Wire):
    """Athena's structured review output (subset the loop reasons about)."""

    summary: str = ""
    critical: tuple[Finding, ...] = ()
    major: tuple[Finding, ...] = ()
    minor: tuple[Finding, ...] = ()
    jane_street_standard: JaneStreetStandard = Field(default_factory=JaneStreetStandard)


class DebtItem(_Wire):
    """A single technical-debt item from Hephaestus."""

    id: str = ""
    priority: str = ""  # p0 | p1 | p2 | p3
    category: str = ""
    location: str = ""
    description: str = ""
    risk: str = ""
    remediation: str = ""
    effort: str = ""


class DebtSummary(_Wire):
    verdict: str = ""  # clean | manageable | concerning | critical


class TechDebtReport(_Wire):
    """Hephaestus's structured audit output (subset the loop reasons about)."""

    debt_summary: DebtSummary = Field(default_factory=DebtSummary)
    items: tuple[DebtItem, ...] = ()


class PullRequest(_Wire):
    """One planned PR from Zeus. ``dependencies`` are other PR ids."""

    id: str
    name: str = ""
    description: str = ""
    scope: str = ""
    dependencies: tuple[str, ...] = ()
    risk_level: str = ""


class ZeusPlan(_Wire):
    """Zeus's plan (subset the loop reasons about)."""

    feature_summary: str = ""
    pull_requests: tuple[PullRequest, ...] = ()


class SliceFile(_Wire):
    """A file an execution slice will create or modify."""

    path: str = ""
    action: str = ""  # create | modify
    purpose: str = ""


class Slice(_Wire):
    """One execution slice from Odysseus. ``dependencies`` are other slice ids.

    A slice is the unit of work handed to an implementer: an independently
    mergeable change with explicit acceptance criteria.
    """

    id: str
    name: str = ""
    description: str = ""
    dependencies: tuple[str, ...] = ()
    acceptance_criteria: tuple[str, ...] = ()
    files: tuple[SliceFile, ...] = ()
    risk_level: str = ""


class BlockingIssue(_Wire):
    """A blocker Odysseus surfaces before implementation can proceed."""

    issue: str = ""
    severity: str = ""
    remediation: str = ""


class OdysseusPlan(_Wire):
    """Odysseus's execution decomposition (subset the loop reasons about)."""

    spec_summary: str = ""
    slices: tuple[Slice, ...] = ()
    blocking_issues: tuple[BlockingIssue, ...] = ()


# --------------------------------------------------------------------------- #
# DOMAIN — Olympus-owned internal types                                        #
# --------------------------------------------------------------------------- #
class Task(_Frozen):
    """A unit of work routed to one implementer.

    ``spec`` is the full natural-language instruction handed to the agent.
    ``blocker_ids`` is non-empty only for fix tasks; it records which blockers
    this task is meant to resolve, so the next review can confirm closure.
    """

    id: str
    kind: TaskKind
    title: str
    spec: str
    blocker_ids: tuple[str, ...] = ()


class Blocker(_Frozen):
    """A normalized, must-fix issue derived from a review or debt audit.

    Both Athena findings and Hephaestus debt items collapse into this single
    shape so the fix agent receives a uniform work list.
    """

    id: str
    source: Literal["code_review", "tech_debt"]
    # Spans both namespaces: code-review severities and any debt priority a
    # policy may block on (p0–p3), so a custom debt_priorities_blocking set
    # never makes a Blocker unconstructible.
    severity: Literal["critical", "major", "p0", "p1", "p2", "p3"]
    location: str
    description: str
    remediation: str


class ImplementationResult(_Frozen):
    """Outcome of one implementer run.

    ``touched_files`` is captured by intercepting the agent's file tool calls,
    not by parsing its prose — so it is accurate even if the JSON summary lies.
    ``report`` is the raw parsed JSON, kept for the audit trail. ``error`` is
    set (and ``touched_files`` empty) when the agent run failed outright.
    """

    task_id: str
    agent: str
    summary: str
    touched_files: tuple[str, ...] = ()
    report: dict[str, object] = Field(default_factory=dict)
    error: str | None = None


class ReviewOutcome(_Frozen):
    """The combined verdict of a review round.

    ``blockers`` is derived (see ``core.derive_blockers``); ``approved`` mirrors
    Athena's ``would_approve`` AND the absence of blocking debt.
    """

    code_review: CodeReview
    tech_debt: TechDebtReport
    blockers: tuple[Blocker, ...]
    approved: bool


class Decision(_Frozen):
    """A loop-control decision with status present only for terminal stops."""

    kind: DecisionKind
    status: RunStatus | None = None

    @model_validator(mode="after")
    def _status_matches_kind(self) -> Decision:
        if self.kind is DecisionKind.STOP and self.status is None:
            raise ValueError("stop decisions require a terminal status")
        if self.kind is DecisionKind.CONTINUE and self.status is not None:
            raise ValueError("continue decisions must not carry a status")
        return self


class RoundResult(_Frozen):
    """Everything that happened in one implement→review iteration."""

    index: int
    tasks: tuple[Task, ...]
    implementations: tuple[ImplementationResult, ...]
    review: ReviewOutcome


class FinalReport(_Frozen):
    """The full, immutable record of an orchestration run."""

    status: RunStatus
    feature_summary: str
    plan: ZeusPlan
    execution_plan: OdysseusPlan
    rounds: tuple[RoundResult, ...]
    iterations: int
    blockers_remaining: tuple[Blocker, ...]


class LoopPolicy(_Frozen):
    """Tunable, declarative loop parameters. Defaults encode the prompts' own
    blocking rules so the loop and the agents agree on what "done" means."""

    max_iterations: int = Field(default=4, ge=1)
    # Major findings block only in these categories (matches Athena's would_approve rule).
    major_categories_blocking: frozenset[str] = frozenset(
        {"type_weakness", "concurrency", "undefined_behavior"}
    )
    # Debt priorities that must be cleared before shipping.
    debt_priorities_blocking: frozenset[str] = frozenset({"p0", "p1"})
    # Require Athena's explicit would_approve in addition to an empty blocker set.
    require_explicit_approval: bool = True
