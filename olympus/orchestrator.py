"""The loop — the imperative shell.

Pure decisions come from ``core``; effectful steps come from the injected
``Effects`` bundle. The shape of one run:

  Zeus ─▶ Odysseus ─▶ [ implement waves ] ─▶ review ∥ audit ─▶ decide
                            ▲                                     │
                            └──────────── fix tasks ◀─────────────┘  while blockers

Zeus plans the architecture; Odysseus decomposes it into dependency-ordered
slices. Round 0 implements those slices wave-by-wave (parallel within a wave,
barrier between waves). Each subsequent round implements independent fix tasks
fully in parallel. Review and audit always run concurrently. The loop stops when
a round is approved (PASSED) or the iteration budget is spent (MAX_ITERATIONS).
"""

from __future__ import annotations

import asyncio

from . import core
from .effects import Effects
from .models import (
    DecisionKind,
    FinalReport,
    ImplementationResult,
    LoopPolicy,
    OdysseusPlan,
    ReviewOutcome,
    RoundResult,
    RunStatus,
    Task,
    ZeusPlan,
)


async def _implement_wave(
    effects: Effects, tasks: tuple[Task, ...]
) -> tuple[ImplementationResult, ...]:
    """Implement one wave of mutually-independent tasks concurrently."""
    if not tasks:
        return ()
    results = await asyncio.gather(*(effects.implement(t) for t in tasks))
    return tuple(results)


async def _review(effects: Effects, files: tuple[str, ...], policy: LoopPolicy) -> ReviewOutcome:
    """Run code review and tech-debt audit concurrently, then combine (pure)."""
    review, debt = await asyncio.gather(effects.review(files), effects.audit(files))
    return core.make_review_outcome(review, debt, policy)


async def orchestrate(
    spec_text: str,
    effects: Effects,
    policy: LoopPolicy | None = None,
) -> FinalReport:
    """Run the full plan→implement→review→fix loop to a terminal status."""
    policy = policy or LoopPolicy()
    # Zeus plans the architecture; Odysseus decomposes it into ordered slices.
    plan = await effects.plan(spec_text)
    execution_plan = await effects.orchestrate(spec_text, plan)

    try:
        task_waves = core.slices_to_task_waves(execution_plan)
    except core.PlanError:
        # An unrecoverable planning defect from Odysseus (dependency cycle or
        # duplicate slice ids). Report FAILED rather than crashing the caller.
        return _report(RunStatus.FAILED, plan, execution_plan, rounds=())
    if not any(task_waves):
        return _report(RunStatus.NO_TASKS, plan, execution_plan, rounds=())

    rounds: tuple[RoundResult, ...] = ()
    # Round 0 work is the planned features, grouped into dependency waves.
    pending_waves = task_waves

    for iteration in range(policy.max_iterations):
        round_tasks = tuple(t for wave in pending_waves for t in wave)
        implementations = await _implement_round(effects, pending_waves)
        files = core.changed_files(implementations)
        outcome = await _review(effects, files, policy)

        rounds += (
            RoundResult(
                index=iteration,
                tasks=round_tasks,
                implementations=implementations,
                review=outcome,
            ),
        )

        decision = core.decide(outcome, iteration, policy)
        if decision.kind is DecisionKind.STOP:
            return _report(decision.status, plan, execution_plan, rounds, outcome.blockers)

        # Next round: fix the blockers. Fix tasks are independent → a single wave.
        # (decide() guarantees outcome.blockers is non-empty when continuing.)
        pending_waves = (core.fix_tasks(outcome.blockers, iteration + 1),)

    # Reached only when max_iterations < 1 (no round ran).
    return _report(RunStatus.MAX_ITERATIONS, plan, execution_plan, rounds)


async def _implement_round(
    effects: Effects, waves: tuple[tuple[Task, ...], ...]
) -> tuple[ImplementationResult, ...]:
    """Implement every wave in order, with a barrier between waves."""
    out: list[ImplementationResult] = []
    for wave in waves:
        out.extend(await _implement_wave(effects, wave))
    return tuple(out)


def _report(
    status: RunStatus,
    plan: ZeusPlan,
    execution_plan: OdysseusPlan,
    rounds: tuple[RoundResult, ...] = (),
    blockers=(),
) -> FinalReport:
    """Assemble the immutable final report (pure)."""
    return FinalReport(
        status=status,
        feature_summary=plan.feature_summary or execution_plan.spec_summary,
        plan=plan,
        execution_plan=execution_plan,
        rounds=rounds,
        iterations=len(rounds),
        blockers_remaining=tuple(blockers),
    )
