# Olympus Agent Contract

Olympus is a Python orchestration tool that drives agent planning,
implementation, review, audit, and fix loops. It has a pure functional core and
an imperative shell that can write to the target root when invoked that way.

## Read First

- `README.md`
- `models.py`
- `core.py`
- `orchestrator.py`
- `client.py`
- `effects.py`
- `registry.py`

## Main Surfaces

- `models.py`: frozen wire and domain models shared by the loop.
- `core.py`: pure decisions for blockers, verdicts, fix tasks, slice waves, and
  thinking-token clamps.
- `orchestrator.py`: loop composition that connects pure decisions to effectful
  agent calls.
- `effects.py`: injectable boundary for planner, implementer, reviewer, auditor,
  and fixer effects.
- `client.py`: Claude Code CLI shell, tool-use tracking, changed-file capture,
  and JSON extraction.
- `registry.py`: agent roster, model selection, thinking budgets, prompts, and
  write-access policy.
- `paths.py` and `jsonio.py`: root sandboxing and robust model-output parsing.

## Key Entry Points

| Symbol | File | Start Here When | Contract |
| --- | --- | --- | --- |
| `main` | `cli.py` | Changing CLI invocation | Load spec text, configure runner/effects, execute the loop, and return process status. |
| `orchestrate` | `orchestrator.py` | Changing the full agent loop | Plan, slice, implement waves, review/audit, decide, and emit immutable final reports. |
| `slice_waves` | `core.py` | Editing dependency ordering | Convert execution slices into deterministic acyclic waves. |
| `derive_blockers` | `core.py` | Changing review/audit blocking policy | Collapse code-review and debt outputs into normalized blocking issues. |
| `decide` | `core.py` | Editing loop termination | Choose continue or terminal status from review outcome, iteration, and policy. |
| `live_effects` | `effects.py` | Wiring agents to the loop | Bind planner, orchestrator, implementer, reviewer, and auditor effects to an `AgentRunner`. |
| `AgentRunner.run` | `client.py` | Changing Claude Code execution | Drive one agent to JSON output while attributing changed files from tool-use events. |
| `implementer_for` | `registry.py` | Changing task routing | Map task kind to the write-enabled or read-only agent spec. |

## Task Routes

| Task | Read | Edit Usually Starts At | Verification |
| --- | --- | --- | --- |
| Change CLI behavior | `README.md`, `cli.py` | `cli.py`, `models.py` for result shape | CLI tests |
| Change planning or dependency waves | `core.py`, `models.py` | `core.py` slice and task helpers | core tests |
| Change review or blocker policy | `core.py`, `../prompts/code-review.md`, `../prompts/tech-debt.md` | `core.py`, `models.py` | core and orchestrator tests |
| Change loop orchestration | `orchestrator.py`, `effects.py` | `orchestrator.py`, `effects.py` | orchestrator tests |
| Change Claude Code execution | `client.py`, `paths.py`, `jsonio.py` | `client.py` | client, path, and JSON extraction tests |
| Change agent roster or prompt routing | `registry.py`, `../prompts/AGENTS.md` | `registry.py`, prompt files | registry tests plus prompt reference review |

## Boundary Contract

- `core.py` contains pure deterministic decisions; network, disk, mutation, SDK,
  and CLI effects stay in the shell modules.
- Changed-file authority comes from intercepted Write/Edit/MultiEdit tool-use
  events rather than agent self-reporting.
- Write-enabled runs target a clean branch or disposable worktree with an
  intentional `--root`.
- Project-local Claude settings remain isolated unless the design explicitly
  changes.
- Blocker semantics stay aligned across README, core policy, and tests.

## Gates

Use the active Python environment with the dependencies from `pyproject.toml`.
Assume source-tree execution from `persephone_street/` so the `olympus` package
resolves from the tree:

```bash
python -m pytest olympus/tests -q
OLYMPUS_LIVE=1 python -m pytest olympus/tests/test_integration_live.py -q
```

The live integration test is opt-in and needs live Claude Code access.
