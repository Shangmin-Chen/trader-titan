"""Tests for CLI spec loading and top-level error handling (C1, M4)."""

from __future__ import annotations

import pytest

import olympus.cli as cli_mod
from olympus.cli import SpecError, _load_spec, main
from olympus.models import FinalReport, RunStatus, Slice
from olympus.tests import factories as f


def test_inline_spec_returned_verbatim():
    assert _load_spec("just a spec") == "just a spec"


def test_at_file_is_read(tmp_path):
    spec = tmp_path / "spec.md"
    spec.write_text("feature spec body", encoding="utf-8")
    assert _load_spec(f"@{spec}") == "feature spec body"


def test_missing_spec_file_raises_specerror(tmp_path):
    with pytest.raises(SpecError, match="not found"):
        _load_spec(f"@{tmp_path / 'nope.md'}")


def test_directory_spec_raises_specerror(tmp_path):
    with pytest.raises(SpecError):
        _load_spec(f"@{tmp_path}")  # a directory, not a file


def test_main_returns_exit_code_2_on_bad_spec_file(tmp_path):
    # Reaches _load_spec before any network call, so this is hermetic.
    code = main([f"@{tmp_path / 'missing.md'}", "--root", str(tmp_path)])
    assert code == 2


def _final_report(status=RunStatus.PASSED):
    return FinalReport(
        status=status,
        feature_summary="f",
        plan=f.plan(),
        execution_plan=f.execplan(),
        rounds=(),
        iterations=0,
        blockers_remaining=(),
    )


def test_main_reports_agent_schema_error_cleanly(tmp_path, monkeypatch):
    # An agent returning schema-invalid JSON raises ValidationError mid-run; the
    # CLI must catch it (exit 1), not dump a traceback (D-C2).
    async def _boom(*_args, **_kwargs):
        Slice.model_validate({"name": "no id"})  # missing required id -> ValidationError

    monkeypatch.setattr(cli_mod, "orchestrate", _boom)
    code = main(["build a thing", "--root", str(tmp_path)])
    assert code == 1


def test_main_handles_out_write_failure(tmp_path, monkeypatch):
    # A successful run whose --out path is unwritable must exit 1 cleanly (D-M4).
    async def _ok(*_args, **_kwargs):
        return _final_report(RunStatus.PASSED)

    monkeypatch.setattr(cli_mod, "orchestrate", _ok)
    bad_out = tmp_path / "missing_dir" / "report.json"  # parent does not exist
    code = main(["build a thing", "--root", str(tmp_path), "--out", str(bad_out)])
    assert code == 1


def test_main_exit_code_reflects_non_passing_status(tmp_path, monkeypatch):
    async def _stalled(*_args, **_kwargs):
        return _final_report(RunStatus.STALLED)

    monkeypatch.setattr(cli_mod, "orchestrate", _stalled)
    code = main(["build a thing", "--root", str(tmp_path)])
    assert code == 1
