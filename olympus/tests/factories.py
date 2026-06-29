"""Tiny constructors for building wire/domain models in tests."""

from __future__ import annotations

from olympus.models import (
    CodeReview,
    DebtItem,
    DebtSummary,
    Finding,
    JaneStreetStandard,
    OdysseusPlan,
    PullRequest,
    Slice,
    SliceFile,
    TechDebtReport,
    ZeusPlan,
)


def plan(*prs: tuple[str, tuple[str, ...]]) -> ZeusPlan:
    """Build a ZeusPlan from (id, dependencies) pairs."""
    return ZeusPlan(
        feature_summary="feature",
        pull_requests=tuple(
            PullRequest(id=pid, name=pid, description=pid, dependencies=deps) for pid, deps in prs
        ),
    )


def execplan(*slices: tuple[str, tuple[str, ...]]) -> OdysseusPlan:
    """Build an OdysseusPlan from (slice_id, dependencies) pairs."""
    return OdysseusPlan(
        spec_summary="spec",
        slices=tuple(
            Slice(
                id=sid,
                name=sid,
                description=f"implement {sid}",
                dependencies=deps,
                acceptance_criteria=(f"{sid} works",),
                files=(SliceFile(path=f"{sid}.py", action="create", purpose=sid),),
            )
            for sid, deps in slices
        ),
    )


def review(critical: int = 0, major: int = 0, approve: bool = True) -> CodeReview:
    """Build a CodeReview with N critical and N major (type_weakness) findings."""
    crit = tuple(
        Finding(id=f"C{i}", category="correctness", location="a.py", finding="bug", fix="fix it")
        for i in range(critical)
    )
    maj = tuple(
        Finding(
            id=f"M{i}", category="type_weakness", location="b.py", finding="weak", fix="strengthen"
        )
        for i in range(major)
    )
    return CodeReview(
        critical=crit,
        major=maj,
        jane_street_standard=JaneStreetStandard(would_approve=approve),
    )


def debt(p0: int = 0, p2: int = 0) -> TechDebtReport:
    """Build a TechDebtReport with N blocking (p0) and N non-blocking (p2) items."""
    items = tuple(
        DebtItem(id=f"P0{i}", priority="p0", location="a.py", description="d", remediation="r")
        for i in range(p0)
    ) + tuple(
        DebtItem(id=f"P2{i}", priority="p2", location="c.py", description="d", remediation="r")
        for i in range(p2)
    )
    verdict = "critical" if p0 else "clean"
    return TechDebtReport(debt_summary=DebtSummary(verdict=verdict), items=items)
