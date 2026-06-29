"""The functional core: pure decision functions.

NOTHING here performs I/O, touches the network, or mutates its inputs. Every
function is total over its declared domain and deterministic. This is where the
loop's correctness lives, and it is unit-testable without an API key.

The orchestrator (the imperative shell) calls into this module for every
decision: what to build, what counts as a blocker, when to stop, what to fix
next, and how to keep thinking budgets API-valid.
"""

from __future__ import annotations

from .models import (
    Blocker,
    CodeReview,
    Decision,
    DecisionKind,
    ImplementationResult,
    LoopPolicy,
    OdysseusPlan,
    ReviewOutcome,
    RunStatus,
    Slice,
    Task,
    TaskKind,
    TechDebtReport,
)


class PlanError(ValueError):
    """An unrecoverable defect in an execution plan (cycle, duplicate ids)."""


class CycleError(PlanError):
    """Raised when a slice dependency graph contains a cycle."""


class DuplicateSliceError(PlanError):
    """Raised when an execution plan contains two slices with the same id."""


# --------------------------------------------------------------------------- #
# Execution plan → tasks                                                       #
# --------------------------------------------------------------------------- #
def slice_waves(slices: tuple[Slice, ...]) -> tuple[tuple[Slice, ...], ...]:
    """Order slices into dependency *waves* via Kahn's algorithm.

    Each returned wave is a set of slices whose dependencies are all satisfied by
    earlier waves; slices within a wave are mutually independent and may be built
    in parallel. Ordering within a wave is by slice id, for determinism.

    Raises ``CycleError`` if the dependency graph is not a DAG, and
    ``DuplicateSliceError`` if two slices share an id (which would otherwise
    silently drop work). Dependencies on unknown slice ids are ignored (treated
    as already satisfied / external), and a slice depending on itself is a root.
    """
    ids = [s.id for s in slices]
    duplicates = sorted({sid for sid in ids if ids.count(sid) > 1})
    if duplicates:
        raise DuplicateSliceError(f"duplicate slice ids: {duplicates}")
    known = {s.id for s in slices}
    by_id = {s.id: s for s in slices}
    deps: dict[str, set[str]] = {
        s.id: {d for d in s.dependencies if d in known and d != s.id} for s in slices
    }

    waves: list[tuple[Slice, ...]] = []
    remaining = set(known)
    while remaining:
        ready = sorted(sid for sid in remaining if not (deps[sid] & remaining))
        if not ready:
            raise CycleError(f"dependency cycle among slices: {sorted(remaining)}")
        waves.append(tuple(by_id[sid] for sid in ready))
        remaining -= set(ready)
    return tuple(waves)


def render_slice_spec(plan: OdysseusPlan, sl: Slice) -> str:
    """Build the instruction handed to an implementer for one slice."""
    lines = [
        f"# Implement slice {sl.id}: {sl.name}",
        "",
        f"## Feature context\n{plan.spec_summary}",
        "",
        f"## This slice\n{sl.description or sl.name}",
    ]
    if sl.files:
        rendered = "\n".join(f"- [{f.action}] {f.path} — {f.purpose}" for f in sl.files)
        lines += ["", f"## Files\n{rendered}"]
    if sl.acceptance_criteria:
        rendered = "\n".join(f"- {c}" for c in sl.acceptance_criteria)
        lines += ["", f"## Acceptance criteria\n{rendered}"]
    if sl.dependencies:
        lines += ["", f"## Depends on\n{', '.join(sl.dependencies)} (already implemented)"]
    return "\n".join(lines)


def slices_to_task_waves(plan: OdysseusPlan) -> tuple[tuple[Task, ...], ...]:
    """Group an execution plan into dependency waves of feature tasks.

    Wave N may be implemented in parallel and only after waves < N are merged.
    Raises ``CycleError`` if the slice dependency graph is not a DAG.
    """
    return tuple(
        tuple(
            Task(
                id=sl.id,
                kind=TaskKind.FEATURE,
                title=sl.name,
                spec=render_slice_spec(plan, sl),
            )
            for sl in wave
        )
        for wave in slice_waves(plan.slices)
    )


# --------------------------------------------------------------------------- #
# Review → blockers → verdict                                                  #
# --------------------------------------------------------------------------- #
def derive_blockers(
    review: CodeReview, debt: TechDebtReport, policy: LoopPolicy
) -> tuple[Blocker, ...]:
    """Collapse a code review and a debt report into one normalized blocker list.

    Every Athena ``critical`` finding blocks. ``major`` findings block only in
    the policy's blocking categories. Debt items block only at the policy's
    blocking priorities (p0/p1 by default). Category and priority comparisons
    are case-insensitive, so an agent emitting ``P0`` or ``Type_Weakness`` is
    still matched rather than silently dropped. Blocker ids are made unique
    (findings/items with a blank id get a positional fallback). Ordering is
    deterministic: code-review criticals, then blocking majors, then debt sorted
    by priority (p0 before p1 …).
    """
    blockers: list[Blocker] = []

    for i, f in enumerate(review.critical):
        blockers.append(
            Blocker(
                id=f"cr:{f.id or f'#{i}'}",
                source="code_review",
                severity="critical",
                location=f.location,
                description=f.finding,
                remediation=f.fix,
            )
        )
    for i, f in enumerate(review.major):
        if f.category.lower() in policy.major_categories_blocking:
            blockers.append(
                Blocker(
                    id=f"cr:{f.id or f'major#{i}'}",
                    source="code_review",
                    severity="major",
                    location=f.location,
                    description=f.finding,
                    remediation=f.fix,
                )
            )
    blocking_debt = [
        it for it in debt.items if it.priority.lower() in policy.debt_priorities_blocking
    ]
    for i, it in enumerate(sorted(blocking_debt, key=lambda d: d.priority.lower())):
        blockers.append(
            Blocker(
                id=f"td:{it.id or f'#{i}'}",
                source="tech_debt",
                severity=it.priority.lower(),
                location=it.location,
                description=it.description,
                remediation=it.remediation,
            )
        )
    return tuple(blockers)


def make_review_outcome(
    review: CodeReview, debt: TechDebtReport, policy: LoopPolicy
) -> ReviewOutcome:
    """Assemble the combined verdict for a round (pure)."""
    blockers = derive_blockers(review, debt, policy)
    approved = (len(blockers) == 0) and (
        review.jane_street_standard.would_approve or not policy.require_explicit_approval
    )
    return ReviewOutcome(code_review=review, tech_debt=debt, blockers=blockers, approved=approved)


def decide(outcome: ReviewOutcome, iteration: int, policy: LoopPolicy) -> Decision:
    """Return whether the loop should stop or run another round.

    ``iteration`` is zero-based: the round that just finished. The returned
    ``Decision`` preserves the invariant that only stop decisions carry a
    terminal status. Cases, in order:

    - ``PASSED``         — the outcome is approved.
    - ``STALLED``        — not approved, but there are no blockers to act on, so
      another round would derive zero fix tasks and re-review unchanged code.
      Stopping avoids burning the iteration budget doing nothing.
    - ``MAX_ITERATIONS`` — blockers remain but the budget is exhausted.
    - ``CONTINUE``       — blockers remain and the budget allows another round.
    """
    if outcome.approved:
        return Decision(kind=DecisionKind.STOP, status=RunStatus.PASSED)
    if not outcome.blockers:
        return Decision(kind=DecisionKind.STOP, status=RunStatus.STALLED)
    if iteration + 1 >= policy.max_iterations:
        return Decision(kind=DecisionKind.STOP, status=RunStatus.MAX_ITERATIONS)
    return Decision(kind=DecisionKind.CONTINUE)


# --------------------------------------------------------------------------- #
# Blockers → fix tasks                                                         #
# --------------------------------------------------------------------------- #
def render_fix_spec(location: str, blockers: tuple[Blocker, ...]) -> str:
    """Build the instruction handed to Chiron for a group of blockers."""
    head = [f"# Resolve {len(blockers)} blocking issue(s) in {location}", ""]
    body: list[str] = []
    for b in blockers:
        body += [
            f"## [{b.severity}] {b.id} ({b.source})",
            f"- Problem: {b.description}",
            f"- Required remediation: {b.remediation or '(derive the minimal correct fix)'}",
            "",
        ]
    tail = [
        "Apply the minimal, targeted fix for each issue. Do not refactor beyond "
        "scope. Strengthen types over adding runtime checks where possible.",
    ]
    return "\n".join(head + body + tail)


def fix_tasks(blockers: tuple[Blocker, ...], round_index: int) -> tuple[Task, ...]:
    """Group blockers by location into one fix task each (deterministic order).

    Grouping by location avoids spawning several fix agents that would edit the
    same file and conflict. Locations are emitted in sorted order.
    """
    groups: dict[str, list[Blocker]] = {}
    for b in blockers:
        groups.setdefault(b.location, []).append(b)

    tasks: list[Task] = []
    for i, location in enumerate(sorted(groups), start=1):
        group = tuple(groups[location])
        tasks.append(
            Task(
                id=f"R{round_index}-FIX{i}",
                kind=TaskKind.FIX,
                title=f"Fix {len(group)} issue(s) in {location}",
                spec=render_fix_spec(location, group),
                blocker_ids=tuple(b.id for b in group),
            )
        )
    return tuple(tasks)


# --------------------------------------------------------------------------- #
# Misc pure helpers                                                            #
# --------------------------------------------------------------------------- #
def changed_files(results: tuple[ImplementationResult, ...]) -> tuple[str, ...]:
    """Sorted, de-duplicated union of files touched across implementations."""
    seen: set[str] = set()
    for r in results:
        seen.update(r.touched_files)
    return tuple(sorted(seen))


def clamp_thinking(configured: int, max_tokens: int, answer_reserve: int) -> int:
    """Clamp a configured thinking budget to an API-valid per-call value.

    The Anthropic API requires ``1024 <= budget_tokens < max_tokens``. The
    Claude Code subagent budgets (250k / 1M) are session-level ceilings, not
    per-call values, so a single SDK call clamps them down to leave
    ``answer_reserve`` tokens for the response itself.
    """
    ceiling = max_tokens - answer_reserve
    if ceiling < 1024:
        raise ValueError(
            f"max_tokens={max_tokens} too small to reserve {answer_reserve} and still think"
        )
    return max(1024, min(configured, ceiling))
