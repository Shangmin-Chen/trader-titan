"""End-to-end loop tests driven by FAKE effects — zero network, zero disk.

Proves the orchestration logic: the Zeus→Odysseus→implement→review→fix path,
termination, iteration counting, dependency-wave ordering, fix-task feedback,
failure tolerance, and that reviewers see the changed files.
"""

from __future__ import annotations

import asyncio

from olympus.effects import Effects
from olympus.models import ImplementationResult, LoopPolicy, RunStatus, TaskKind
from olympus.orchestrator import orchestrate
from olympus.tests import factories as f


def _effects(execplan, reviews, debts, *, order=None, fail_ids=(), review_files=None, calls=None):
    """A fake Effects bundle replaying scripted review/debt outcomes.

    ``order`` records implemented task ids; ``fail_ids`` makes those implementers
    return an error result (mirroring live behavior, which never raises);
    ``review_files`` records the file tuple each review receives; ``calls``
    records which high-level effects fired.
    """
    review_iter = iter(reviews)
    debt_iter = iter(debts)

    async def _plan(_spec):
        if calls is not None:
            calls.append("plan")
        return f.plan(("PR1", ()))

    async def _orchestrate(_spec, _plan):
        if calls is not None:
            calls.append("orchestrate")
        return execplan

    async def _implement(task):
        if order is not None:
            order.append(task.id)
        if task.id in fail_ids:
            return ImplementationResult(task_id=task.id, agent="fake", summary="", error="boom")
        return ImplementationResult(
            task_id=task.id, agent="fake", summary="done", touched_files=(f"{task.id}.py",)
        )

    async def _review(files):
        if review_files is not None:
            review_files.append(files)
        return next(review_iter)

    async def _audit(_files):
        return next(debt_iter)

    return Effects(
        plan=_plan, orchestrate=_orchestrate, implement=_implement, review=_review, audit=_audit
    )


def _run(execplan, reviews, debts, policy=None, **kw):
    effects = _effects(execplan, reviews, debts, **kw)
    return asyncio.run(orchestrate("spec", effects, policy or LoopPolicy()))


# --------------------------------------------------------------------------- #
# agent path                                                                   #
# --------------------------------------------------------------------------- #
def test_full_agent_path_invokes_zeus_then_odysseus():
    calls: list[str] = []
    _run(f.execplan(("A", ())), [f.review(approve=True)], [f.debt()], calls=calls)
    assert calls[:2] == ["plan", "orchestrate"]


def test_clean_first_round_passes_in_one_iteration():
    report = _run(f.execplan(("A", ())), [f.review(approve=True)], [f.debt()])
    assert report.status is RunStatus.PASSED
    assert report.iterations == 1
    assert report.blockers_remaining == ()
    assert report.execution_plan.slices[0].id == "A"


# --------------------------------------------------------------------------- #
# fix loop                                                                      #
# --------------------------------------------------------------------------- #
def test_blockers_then_clean_takes_two_iterations_with_fix_tasks():
    order: list[str] = []
    report = _run(
        f.execplan(("A", ())),
        [f.review(critical=1, approve=False), f.review(approve=True)],
        [f.debt(), f.debt()],
        order=order,
    )
    assert report.status is RunStatus.PASSED and report.iterations == 2
    assert report.rounds[0].tasks[0].kind is TaskKind.FEATURE
    assert report.rounds[1].tasks[0].kind is TaskKind.FIX
    assert "a.py" in report.rounds[1].tasks[0].title
    assert order[0] == "A" and order[1].startswith("R1-FIX")


def test_persistent_blockers_stop_at_max_iterations():
    report = _run(
        f.execplan(("A", ())),
        [f.review(critical=1, approve=False)] * 3,
        [f.debt()] * 3,
        policy=LoopPolicy(max_iterations=3),
    )
    assert report.status is RunStatus.MAX_ITERATIONS
    assert report.iterations == 3
    assert len(report.blockers_remaining) == 1


def test_single_iteration_budget_stops_immediately_on_blockers():
    report = _run(
        f.execplan(("A", ())),
        [f.review(critical=1, approve=False)],
        [f.debt()],
        policy=LoopPolicy(max_iterations=1),
    )
    assert report.status is RunStatus.MAX_ITERATIONS and report.iterations == 1


def test_tech_debt_alone_blocks_then_resolves():
    report = _run(
        f.execplan(("A", ())),
        [f.review(approve=True), f.review(approve=True)],
        [f.debt(p0=1), f.debt()],
    )
    assert report.status is RunStatus.PASSED and report.iterations == 2
    assert report.rounds[1].tasks[0].kind is TaskKind.FIX


def test_multiple_blocker_locations_produce_multiple_fix_tasks():
    review = f.review(critical=2, approve=False)
    # two criticals at a.py and b.py
    review = review.model_copy(
        update={
            "critical": (
                review.critical[0].model_copy(update={"location": "a.py"}),
                review.critical[1].model_copy(update={"location": "b.py"}),
            )
        }
    )
    report = _run(f.execplan(("A", ())), [review, f.review(approve=True)], [f.debt(), f.debt()])
    assert len(report.rounds[1].tasks) == 2
    assert {t.title.split(" in ")[-1] for t in report.rounds[1].tasks} == {"a.py", "b.py"}


# --------------------------------------------------------------------------- #
# ordering, files, failures                                                    #
# --------------------------------------------------------------------------- #
def test_dependency_waves_implement_in_order():
    order: list[str] = []
    _run(
        f.execplan(("B", ()), ("A", ()), ("C", ("A", "B"))),
        [f.review(approve=True)],
        [f.debt()],
        order=order,
    )
    assert order == ["A", "B", "C"]


def test_reviewers_receive_changed_files():
    review_files: list[tuple[str, ...]] = []
    _run(
        f.execplan(("A", ()), ("B", ())),
        [f.review(approve=True)],
        [f.debt()],
        review_files=review_files,
    )
    assert review_files[0] == ("A.py", "B.py")


def test_implementer_failure_is_tolerated_and_excluded_from_files():
    review_files: list[tuple[str, ...]] = []
    report = _run(
        f.execplan(("A", ()), ("B", ())),
        [f.review(approve=True)],
        [f.debt()],
        fail_ids=("A",),
        review_files=review_files,
    )
    # A failed -> only B's file reaches review; run still completes.
    assert review_files[0] == ("B.py",)
    assert report.status is RunStatus.PASSED
    failed = [i for r in report.rounds for i in r.implementations if i.error]
    assert failed and failed[0].task_id == "A"


# --------------------------------------------------------------------------- #
# degenerate plans                                                             #
# --------------------------------------------------------------------------- #
def test_empty_execution_plan_is_no_tasks():
    report = _run(f.execplan(), [], [])
    assert report.status is RunStatus.NO_TASKS and report.iterations == 0


def test_cyclic_execution_plan_reports_failed():
    # A cyclic slice graph must produce a clean FAILED report, not a traceback.
    report = _run(f.execplan(("A", ("B",)), ("B", ("A",))), [], [])
    assert report.status is RunStatus.FAILED
    assert report.iterations == 0
    assert report.rounds == ()


def test_duplicate_slice_ids_report_failed():
    # Duplicate slice ids are an unrecoverable planning defect -> FAILED, no spin.
    report = _run(f.execplan(("A", ()), ("A", ())), [], [])
    assert report.status is RunStatus.FAILED and report.rounds == ()


def test_not_approved_with_no_blockers_stalls_after_one_round():
    # Review withholds approval but produces no actionable blockers: the loop must
    # STALL after round 0 rather than spin empty rounds to the iteration budget.
    order: list[str] = []
    report = _run(
        f.execplan(("A", ())),
        [f.review(approve=False)],  # would_approve=False, zero findings
        [f.debt()],
        policy=LoopPolicy(max_iterations=4),
        order=order,
    )
    assert report.status is RunStatus.STALLED
    assert report.iterations == 1  # did NOT spin to max_iterations
    assert order == ["A"]  # only round 0's implement ran
