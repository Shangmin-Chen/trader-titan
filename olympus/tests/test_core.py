"""Exhaustive unit tests for the pure decision core. No I/O, no mocks.

Covers happy paths, boundaries, empty inputs, ordering determinism, and
adversarial graphs (cycles, self-deps, unknown deps).
"""

from __future__ import annotations

import pytest

from olympus import core
from olympus.models import (
    Blocker,
    CodeReview,
    DebtItem,
    DecisionKind,
    Finding,
    ImplementationResult,
    JaneStreetStandard,
    LoopPolicy,
    RunStatus,
    TaskKind,
    TechDebtReport,
)
from olympus.tests import factories as f


def _blocker(bid="cr:C0", location="a.py", severity="critical", source="code_review"):
    return Blocker(
        id=bid,
        source=source,
        severity=severity,
        location=location,
        description="d",
        remediation="r",
    )


# --------------------------------------------------------------------------- #
# slice_waves                                                                  #
# --------------------------------------------------------------------------- #
def test_slice_waves_empty():
    assert core.slice_waves(()) == ()


def test_slice_waves_single():
    waves = core.slice_waves(f.execplan(("A", ())).slices)
    assert [tuple(s.id for s in w) for w in waves] == [("A",)]


def test_slice_waves_linear_chain():
    waves = core.slice_waves(f.execplan(("A", ()), ("B", ("A",)), ("C", ("B",))).slices)
    assert [tuple(s.id for s in w) for w in waves] == [("A",), ("B",), ("C",)]


def test_slice_waves_parallel_roots_sorted():
    waves = core.slice_waves(f.execplan(("B", ()), ("A", ()), ("C", ("A", "B"))).slices)
    assert [tuple(s.id for s in w) for w in waves] == [("A", "B"), ("C",)]


def test_slice_waves_diamond():
    waves = core.slice_waves(
        f.execplan(("A", ()), ("B", ("A",)), ("C", ("A",)), ("D", ("B", "C"))).slices
    )
    assert [tuple(s.id for s in w) for w in waves] == [("A",), ("B", "C"), ("D",)]


def test_slice_waves_unknown_dependency_ignored():
    waves = core.slice_waves(f.execplan(("A", ("EXTERNAL",))).slices)
    assert [tuple(s.id for s in w) for w in waves] == [("A",)]


def test_slice_waves_self_dependency_is_root():
    waves = core.slice_waves(f.execplan(("A", ("A",))).slices)
    assert [tuple(s.id for s in w) for w in waves] == [("A",)]


def test_slice_waves_cycle_raises():
    with pytest.raises(core.CycleError):
        core.slice_waves(f.execplan(("A", ("B",)), ("B", ("A",))).slices)


def test_slice_waves_three_cycle_raises():
    with pytest.raises(core.CycleError):
        core.slice_waves(f.execplan(("A", ("C",)), ("B", ("A",)), ("C", ("B",))).slices)


def test_slice_waves_duplicate_ids_raise():
    # Two slices sharing an id would silently overwrite in a dict — must raise.
    with pytest.raises(core.DuplicateSliceError):
        core.slice_waves(f.execplan(("A", ()), ("A", ())).slices)


def test_duplicate_slice_error_is_a_plan_error():
    assert issubclass(core.DuplicateSliceError, core.PlanError)
    assert issubclass(core.CycleError, core.PlanError)


# --------------------------------------------------------------------------- #
# slices_to_task_waves / render_slice_spec                                     #
# --------------------------------------------------------------------------- #
def test_slices_to_task_waves_are_feature_tasks_in_order():
    waves = core.slices_to_task_waves(f.execplan(("A", ()), ("B", ("A",))))
    assert [tuple(t.id for t in w) for w in waves] == [("A",), ("B",)]
    assert all(t.kind is TaskKind.FEATURE for w in waves for t in w)


def test_render_slice_spec_includes_context_files_and_criteria():
    plan = f.execplan(("A", ("B",)))
    spec = core.render_slice_spec(plan, plan.slices[0])
    assert "A" in spec and "implement A" in spec
    assert "A.py" in spec  # file path
    assert "A works" in spec  # acceptance criterion
    assert "B" in spec  # dependency


def test_slices_to_task_waves_propagates_cycle():
    with pytest.raises(core.CycleError):
        core.slices_to_task_waves(f.execplan(("A", ("B",)), ("B", ("A",))))


# --------------------------------------------------------------------------- #
# derive_blockers                                                             #
# --------------------------------------------------------------------------- #
def test_critical_findings_always_block():
    blockers = core.derive_blockers(f.review(critical=2, approve=False), f.debt(), LoopPolicy())
    assert len(blockers) == 2
    assert all(b.severity == "critical" and b.source == "code_review" for b in blockers)
    assert all(b.id.startswith("cr:") for b in blockers)


def test_major_blocks_only_in_blocking_categories():
    blocking = core.derive_blockers(f.review(major=1, approve=False), f.debt(), LoopPolicy())
    assert len(blocking) == 1 and blocking[0].severity == "major"
    relaxed = LoopPolicy(major_categories_blocking=frozenset())
    assert core.derive_blockers(f.review(major=1, approve=False), f.debt(), relaxed) == ()


def test_non_blocking_major_category_excluded():
    review = f.review(approve=False)
    review = review.model_copy(
        update={"major": (Finding(id="M9", category="naming", location="x", finding="n", fix="f"),)}
    )
    assert core.derive_blockers(review, f.debt(), LoopPolicy()) == ()


def test_only_p0_p1_debt_blocks():
    blockers = core.derive_blockers(f.review(approve=True), f.debt(p0=1, p2=3), LoopPolicy())
    assert [b.source for b in blockers] == ["tech_debt"]
    assert blockers[0].severity == "p0" and blockers[0].id.startswith("td:")


def test_blocker_ordering_is_critical_then_major_then_debt():
    blockers = core.derive_blockers(
        f.review(critical=1, major=1, approve=False), f.debt(p0=1), LoopPolicy()
    )
    assert [b.severity for b in blockers] == ["critical", "major", "p0"]


def test_derive_blockers_empty_when_clean():
    assert core.derive_blockers(f.review(approve=True), f.debt(), LoopPolicy()) == ()


def test_derive_blockers_priority_match_is_case_insensitive():
    # An agent emitting 'P0' (uppercase) must still block, not silently slip through.
    debt = TechDebtReport(
        items=(DebtItem(id="D1", priority="P0", location="a.py", description="d", remediation="r"),)
    )
    blockers = core.derive_blockers(f.review(approve=True), debt, LoopPolicy())
    assert len(blockers) == 1 and blockers[0].severity == "p0"


def test_derive_blockers_category_match_is_case_insensitive():
    review = CodeReview(
        major=(Finding(id="M1", category="Type_Weakness", location="b.py", finding="x", fix="f"),),
        jane_street_standard=JaneStreetStandard(would_approve=False),
    )
    blockers = core.derive_blockers(review, f.debt(), LoopPolicy())
    assert len(blockers) == 1 and blockers[0].severity == "major"


def test_derive_blockers_debt_sorted_by_priority():
    debt = TechDebtReport(
        items=(
            DebtItem(id="D1", priority="p1", location="x", description="d", remediation="r"),
            DebtItem(id="D0", priority="p0", location="y", description="d", remediation="r"),
        )
    )
    blockers = core.derive_blockers(f.review(approve=True), debt, LoopPolicy())
    assert [b.severity for b in blockers] == ["p0", "p1"]


def test_derive_blockers_blank_ids_are_disambiguated():
    review = CodeReview(
        critical=(Finding(location="a.py"), Finding(location="b.py")),  # both id=""
        jane_street_standard=JaneStreetStandard(would_approve=False),
    )
    blockers = core.derive_blockers(review, f.debt(), LoopPolicy())
    assert len({b.id for b in blockers}) == 2  # unique despite blank Finding.id


# --------------------------------------------------------------------------- #
# make_review_outcome                                                         #
# --------------------------------------------------------------------------- #
def test_clean_review_is_approved():
    outcome = core.make_review_outcome(f.review(approve=True), f.debt(), LoopPolicy())
    assert outcome.approved and outcome.blockers == ()


def test_blockers_block_even_if_would_approve_true():
    # would_approve True but a p0 debt item exists -> not approved.
    outcome = core.make_review_outcome(f.review(approve=True), f.debt(p0=1), LoopPolicy())
    assert not outcome.approved and len(outcome.blockers) == 1


def test_no_blockers_but_disapproved_is_not_approved():
    outcome = core.make_review_outcome(f.review(approve=False), f.debt(), LoopPolicy())
    assert not outcome.approved


def test_relaxed_policy_ignores_explicit_approval():
    policy = LoopPolicy(require_explicit_approval=False)
    outcome = core.make_review_outcome(f.review(approve=False), f.debt(), policy)
    assert outcome.approved  # no blockers, and approval not required


# --------------------------------------------------------------------------- #
# decide                                                                      #
# --------------------------------------------------------------------------- #
def test_decide_returns_decision_kind_enum():
    approved = core.make_review_outcome(f.review(approve=True), f.debt(), LoopPolicy())
    blocked = core.make_review_outcome(f.review(critical=1, approve=False), f.debt(), LoopPolicy())
    assert core.decide(approved, 0, LoopPolicy()).kind is DecisionKind.STOP
    assert core.decide(blocked, 0, LoopPolicy(max_iterations=3)).kind is DecisionKind.CONTINUE


def test_decide_stops_passed_when_approved():
    outcome = core.make_review_outcome(f.review(approve=True), f.debt(), LoopPolicy())
    d = core.decide(outcome, iteration=0, policy=LoopPolicy())
    assert d.kind is DecisionKind.STOP and d.status is RunStatus.PASSED


def test_decide_continues_with_budget_left():
    outcome = core.make_review_outcome(f.review(critical=1, approve=False), f.debt(), LoopPolicy())
    d = core.decide(outcome, iteration=0, policy=LoopPolicy(max_iterations=3))
    assert d.kind is DecisionKind.CONTINUE and d.status is None


def test_decide_stops_max_when_budget_spent():
    outcome = core.make_review_outcome(f.review(critical=1, approve=False), f.debt(), LoopPolicy())
    d = core.decide(outcome, iteration=2, policy=LoopPolicy(max_iterations=3))
    assert d.kind is DecisionKind.STOP and d.status is RunStatus.MAX_ITERATIONS


def test_decide_single_iteration_budget_boundary():
    outcome = core.make_review_outcome(f.review(critical=1, approve=False), f.debt(), LoopPolicy())
    d = core.decide(outcome, iteration=0, policy=LoopPolicy(max_iterations=1))
    assert d.kind is DecisionKind.STOP and d.status is RunStatus.MAX_ITERATIONS


def test_decide_stalls_when_not_approved_but_no_blockers():
    # would_approve=False with zero blockers: no fix tasks can be derived, so the
    # loop must stop (STALLED) instead of spinning the budget on empty rounds.
    outcome = core.make_review_outcome(f.review(approve=False), f.debt(), LoopPolicy())
    assert outcome.blockers == () and not outcome.approved
    d = core.decide(outcome, iteration=0, policy=LoopPolicy(max_iterations=4))
    assert d.kind is DecisionKind.STOP and d.status is RunStatus.STALLED


# --------------------------------------------------------------------------- #
# fix_tasks / render_fix_spec                                                 #
# --------------------------------------------------------------------------- #
def test_fix_tasks_empty_blockers():
    assert core.fix_tasks((), round_index=1) == ()


def test_fix_tasks_group_by_location_deterministically():
    blockers = (
        _blocker("cr:C0", "z.py"),
        _blocker("cr:C1", "a.py"),
        _blocker("td:P00", "a.py", "p0", "tech_debt"),
    )
    tasks = core.fix_tasks(blockers, round_index=1)
    assert [t.title.split(" in ")[-1] for t in tasks] == ["a.py", "z.py"]
    assert tasks[0].id == "R1-FIX1" and tasks[0].kind is TaskKind.FIX
    assert set(tasks[0].blocker_ids) == {"cr:C1", "td:P00"}


def test_fix_tasks_ids_increment_per_round():
    blockers = (_blocker("cr:C0", "a.py"), _blocker("cr:C1", "b.py"))
    tasks = core.fix_tasks(blockers, round_index=2)
    assert [t.id for t in tasks] == ["R2-FIX1", "R2-FIX2"]


def test_render_fix_spec_includes_blocker_detail():
    spec = core.render_fix_spec("a.py", (_blocker("cr:C0", "a.py"),))
    assert "cr:C0" in spec and "a.py" in spec and "critical" in spec


# --------------------------------------------------------------------------- #
# changed_files                                                               #
# --------------------------------------------------------------------------- #
def _impl(task_id, files):
    return ImplementationResult(task_id=task_id, agent="x", summary="s", touched_files=files)


def test_changed_files_union_dedup_sorted():
    results = (_impl("A", ("b.py", "a.py")), _impl("B", ("a.py", "c.py")))
    assert core.changed_files(results) == ("a.py", "b.py", "c.py")


def test_changed_files_empty():
    assert core.changed_files(()) == ()
    assert core.changed_files((_impl("A", ()),)) == ()


# --------------------------------------------------------------------------- #
# clamp_thinking                                                              #
# --------------------------------------------------------------------------- #
def test_clamp_thinking_clamps_to_ceiling():
    assert core.clamp_thinking(1_000_000, 64_000, 16_000) == 48_000


def test_clamp_thinking_floors_low_values():
    assert core.clamp_thinking(500, 64_000, 16_000) == 1024
    assert core.clamp_thinking(-10, 64_000, 16_000) == 1024


def test_clamp_thinking_passes_through_valid():
    assert core.clamp_thinking(30_000, 64_000, 16_000) == 30_000


def test_clamp_thinking_exact_ceiling():
    assert core.clamp_thinking(48_000, 64_000, 16_000) == 48_000


def test_clamp_thinking_raises_when_no_room():
    with pytest.raises(ValueError):
        core.clamp_thinking(1_000_000, 1_000, 16_000)
