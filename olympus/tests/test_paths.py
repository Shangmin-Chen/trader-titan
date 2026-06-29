"""Unit tests for filesystem-path sandboxing."""

from __future__ import annotations

import pytest

from olympus.paths import PathEscapeError, resolve_within


def test_relative_path_resolves_inside(tmp_path):
    got = resolve_within(tmp_path, "src/app.py")
    assert got == (tmp_path / "src/app.py").resolve()


def test_root_itself_is_allowed(tmp_path):
    assert resolve_within(tmp_path, ".") == tmp_path.resolve()


def test_parent_traversal_escapes(tmp_path):
    with pytest.raises(PathEscapeError):
        resolve_within(tmp_path, "../secrets.txt")


def test_absolute_outside_escapes(tmp_path):
    with pytest.raises(PathEscapeError):
        resolve_within(tmp_path, "/etc/passwd")


def test_sneaky_traversal_back_inside_is_allowed(tmp_path):
    # ..-then-back must still land inside root.
    got = resolve_within(tmp_path, "src/../src/app.py")
    assert got == (tmp_path / "src/app.py").resolve()


def test_empty_candidate_is_root(tmp_path):
    assert resolve_within(tmp_path, "") == tmp_path.resolve()


def test_deep_traversal_escape(tmp_path):
    with pytest.raises(PathEscapeError):
        resolve_within(tmp_path, "a/b/c/../../../../etc/passwd")


def test_absolute_path_inside_root_allowed(tmp_path):
    inside = str(tmp_path / "pkg/app.py")
    assert resolve_within(tmp_path, inside) == (tmp_path / "pkg/app.py").resolve()


def test_symlink_escape_is_blocked(tmp_path):
    # a symlink pointing outside root must not grant access via resolve().
    outside = tmp_path.parent / "outside_dir"
    outside.mkdir()
    (tmp_path / "link").symlink_to(outside)
    with pytest.raises(PathEscapeError):
        resolve_within(tmp_path, "link/secret.txt")
