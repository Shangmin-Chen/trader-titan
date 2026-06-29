"""Command-line entry point: run the orchestration loop against a real repo.

    python -m olympus.cli "Add a kill-switch to the order router" \
        --root /path/to/repo --max-iterations 4 --out report.json

Runs through your Claude Code session — **no ANTHROPIC_API_KEY needed**; it uses
whatever auth the ``claude`` CLI already has. The feature spec may be given
inline or as @path/to/spec.md. Use --dry-run to run Zeus + Odysseus only and
print the resulting slice decomposition without implementing anything.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from .client import AgentError, AgentRunner
from .core import PlanError
from .effects import live_effects
from .jsonio import JsonExtractionError
from .models import LoopPolicy, RunStatus
from .orchestrator import orchestrate
from .paths import PathEscapeError


class SpecError(RuntimeError):
    """The feature spec could not be loaded (missing, unreadable, or non-text)."""


def _load_spec(raw: str) -> str:
    """Inline spec, or the contents of a file when the arg starts with '@'.

    Raises ``SpecError`` (not a raw OSError) when an ``@file`` cannot be read, so
    the CLI can report it cleanly instead of crashing with a traceback.
    """
    if not raw.startswith("@"):
        return raw
    path = Path(raw[1:])
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise SpecError(f"spec file not found: {path}") from exc
    except PermissionError as exc:
        raise SpecError(f"spec file not readable: {path}") from exc
    except (IsADirectoryError, UnicodeDecodeError) as exc:
        raise SpecError(f"spec file is not a readable UTF-8 text file: {path}") from exc


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="olympus", description=__doc__)
    p.add_argument("spec", help="feature spec, or @file to read it from a file")
    p.add_argument("--root", type=Path, default=Path.cwd(), help="repo root to edit")
    p.add_argument(
        "--prompts-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "prompts",
        help="directory of agent system prompts",
    )
    p.add_argument("--max-iterations", type=int, default=4)
    p.add_argument("--out", type=Path, default=None, help="write the FinalReport JSON here")
    p.add_argument(
        "--allow-bash",
        action="store_true",
        help="let implementers run Bash (e.g. to run gates); off by default",
    )
    p.add_argument("--dry-run", action="store_true", help="plan only; do not implement")
    return p.parse_args(argv)


async def _run(args: argparse.Namespace) -> int:
    runner = AgentRunner(args.root, args.prompts_dir, allow_bash=args.allow_bash)
    effects = live_effects(runner)
    spec = _load_spec(args.spec)

    if args.dry_run:
        plan = await effects.plan(spec)
        execution_plan = await effects.orchestrate(spec, plan)
        print(json.dumps(execution_plan.model_dump(mode="json"), indent=2))
        return 0

    policy = LoopPolicy(max_iterations=args.max_iterations)
    report = await orchestrate(spec, effects, policy)

    text = json.dumps(report.model_dump(mode="json"), indent=2)
    if args.out:
        try:
            args.out.write_text(text, encoding="utf-8")
        except OSError as exc:
            print(f"olympus: could not write report to {args.out}: {exc}", file=sys.stderr)
            return 1
        print(f"status={report.status.value} iterations={report.iterations} -> {args.out}")
    else:
        print(text)
    # Non-zero exit when the loop did not reach an approved state.
    return 0 if report.status is RunStatus.PASSED else 1


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("olympus: interrupted", file=sys.stderr)
        return 130
    except SpecError as exc:
        print(f"olympus: {exc}", file=sys.stderr)
        return 2
    except (AgentError, PlanError, PathEscapeError, JsonExtractionError, ValidationError) as exc:
        # ValidationError: an agent returned JSON that does not match the wire
        # schema (e.g. a Slice missing its id) — report cleanly, don't traceback.
        print(f"olympus: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
