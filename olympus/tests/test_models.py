"""Tests for model contracts: immutability, extra-field policy, validation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from olympus.models import (
    Blocker,
    CodeReview,
    Decision,
    DecisionKind,
    LoopPolicy,
    OdysseusPlan,
    RunStatus,
    Task,
    TaskKind,
    ZeusPlan,
)


def test_wire_models_ignore_unknown_fields():
    # Agent output may carry extra keys; wire models must not choke on them.
    review = CodeReview.model_validate({"summary": "ok", "unknown_future_field": 123})
    assert review.summary == "ok"


def test_wire_models_default_missing_fields():
    review = CodeReview.model_validate({})
    assert review.critical == () and review.jane_street_standard.would_approve is False


def test_domain_models_forbid_unknown_fields():
    with pytest.raises(ValidationError):
        Task(id="A", kind=TaskKind.FEATURE, title="t", spec="s", bogus=1)


def test_domain_models_are_frozen():
    task = Task(id="A", kind=TaskKind.FEATURE, title="t", spec="s")
    with pytest.raises(ValidationError):
        task.title = "changed"


def test_lists_coerce_to_tuples():
    plan = OdysseusPlan.model_validate({"slices": [{"id": "A", "dependencies": ["B"]}]})
    assert isinstance(plan.slices, tuple)
    assert isinstance(plan.slices[0].dependencies, tuple)


def test_zeus_plan_roundtrip_json():
    plan = ZeusPlan.model_validate(
        {"feature_summary": "f", "pull_requests": [{"id": "PR1", "dependencies": ["PR0"]}]}
    )
    dumped = plan.model_dump(mode="json")
    assert ZeusPlan.model_validate(dumped) == plan


def test_blocker_rejects_invalid_source_and_severity():
    # Domain Literal types make invalid states unrepresentable.
    with pytest.raises(ValidationError):
        Blocker(
            id="x",
            source="bogus",
            severity="critical",
            location="a",
            description="d",
            remediation="r",
        )
    with pytest.raises(ValidationError):
        Blocker(
            id="x",
            source="tech_debt",
            severity="p9",
            location="a",
            description="d",
            remediation="r",
        )


def test_blocker_accepts_valid_values():
    b = Blocker(
        id="x", source="tech_debt", severity="p0", location="a", description="d", remediation="r"
    )
    assert b.source == "tech_debt" and b.severity == "p0"


def test_decision_rejects_invalid_kind():
    with pytest.raises(ValidationError):
        Decision(kind="maybe")
    assert Decision(kind=DecisionKind.STOP, status=RunStatus.PASSED).kind is DecisionKind.STOP


def test_decision_enforces_status_kind_invariant():
    # The model_validator makes incoherent decisions unconstructible (survives -O).
    with pytest.raises(ValidationError):
        Decision(kind=DecisionKind.STOP)  # stop without a terminal status
    with pytest.raises(ValidationError):
        Decision(kind=DecisionKind.CONTINUE, status=RunStatus.PASSED)  # continue with status
    assert Decision(kind=DecisionKind.CONTINUE).status is None


def test_blocker_accepts_debt_priorities_p2_p3():
    # Widened severity so a custom debt_priorities_blocking={'p2'} cannot make a
    # Blocker unconstructible in derive_blockers.
    for sev in ("p2", "p3"):
        b = Blocker(
            id="x", source="tech_debt", severity=sev, location="a", description="d", remediation="r"
        )
        assert b.severity == sev


def test_loop_policy_rejects_nonpositive_max_iterations():
    with pytest.raises(ValidationError):
        LoopPolicy(max_iterations=0)
    with pytest.raises(ValidationError):
        LoopPolicy(max_iterations=-1)


def test_loop_policy_defaults_match_prompt_contract():
    p = LoopPolicy()
    assert p.major_categories_blocking == frozenset(
        {"type_weakness", "concurrency", "undefined_behavior"}
    )
    assert p.debt_priorities_blocking == frozenset({"p0", "p1"})
    assert p.require_explicit_approval is True
