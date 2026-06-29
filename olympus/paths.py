"""Pure-ish filesystem-path sandboxing.

The only effect here is ``Path.resolve`` (which consults the filesystem for
symlinks); the logic is otherwise pure and deterministic. Every file tool
routes through ``resolve_within`` so an agent can never read or write outside
the repository root via absolute paths or ``..`` traversal.
"""

from __future__ import annotations

from pathlib import Path


class PathEscapeError(ValueError):
    """Raised when a candidate path resolves outside the sandbox root."""


def resolve_within(root: Path, candidate: str) -> Path:
    """Resolve ``candidate`` (relative to ``root``) and prove it stays inside.

    Candidates that resolve outside the sandbox root — whether via ``..`` or an
    absolute path elsewhere — raise ``PathEscapeError``. Absolute candidates that
    resolve inside the root are permitted. The returned path is fully resolved.
    """
    root_r = root.resolve()
    raw = Path(candidate)
    base = raw if raw.is_absolute() else (root_r / raw)
    # resolve() follows symlinks, so a link pointing outside root is caught here.
    resolved = base.resolve()
    if not resolved.is_relative_to(root_r):
        raise PathEscapeError(f"{candidate!r} resolves outside sandbox root {root_r}")
    return resolved
