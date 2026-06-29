"""Tests for the live effects wiring, especially implement's failure policy.

These lock in the behavior the external review (C3) got wrong: ``implement``
catches ordinary ``Exception`` (recording it as an error result so the loop
survives) but must NOT catch ``BaseException``-derived control signals
(``CancelledError``, ``KeyboardInterrupt``), which have to propagate for
cancellation and Ctrl-C to work.
"""

from __future__ import annotations

import asyncio

import pytest

from olympus.effects import live_effects
from olympus.models import Task, TaskKind


class _FakeRunner:
    """Duck-typed AgentRunner whose run() always raises the given exception."""

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    async def run(self, spec, user_prompt):  # noqa: ARG002 - signature match only
        raise self._exc


_TASK = Task(id="A", kind=TaskKind.FEATURE, title="t", spec="s")


def test_implement_records_ordinary_exception_as_error_result():
    effects = live_effects(_FakeRunner(ValueError("boom")))
    result = asyncio.run(effects.implement(_TASK))
    assert result.error == "boom"
    assert result.touched_files == ()
    assert result.task_id == "A"


def test_implement_propagates_cancelled_error():
    # CancelledError is BaseException-derived → must NOT be swallowed (refutes C3).
    effects = live_effects(_FakeRunner(asyncio.CancelledError()))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(effects.implement(_TASK))


def test_implement_propagates_keyboard_interrupt():
    # KeyboardInterrupt is BaseException-derived → must propagate for Ctrl-C (refutes C3).
    effects = live_effects(_FakeRunner(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        asyncio.run(effects.implement(_TASK))
