# Olympus

A pure-functional agent orchestration loop over the Persephone pantheon, driven
**through your Claude Code session and its existing login.** Olympus takes a
feature spec, has **Zeus** plan the architecture and **Odysseus** decompose it
into ordered slices, drives the implementers to build them in parallel, then
loops **Athena** (code review) ∥ **Hephaestus** (tech-debt) and feeds blocking
findings to **Chiron** until the work is approved or the iteration budget is
spent.

```
Zeus ─▶ Odysseus ─▶ [ implement waves ] ─▶ review ∥ audit ─▶ decide
                          ▲                                     │
                          └──────────── fix tasks ◀─────────────┘   while blockers
```

## Runs Inside Claude Code

The shell drives each agent via `claude_agent_sdk.query`, which shells out to the
`claude` CLI and authenticates with **whatever login the CLI already has** — your
Claude subscription or an existing key. Olympus uses that existing Claude Code
login, and agents use Claude Code's own native tools (Read/Grep/Glob, plus
Write/Edit for the implementers).

## Why it's built this way — functional core, imperative shell

The design goal is the one the Persephone prompts demand of the code they review:
**correctness properties belong in code, not in conventions.** So the loop's
logic is pure and the effects are pushed to the edges — which is exactly why
swapping the raw Anthropic API for the Claude Code CLI touched **one module**
(`client.py`) and left the core and its tests untouched.

| Layer | Modules | Character |
|-------|---------|-----------|
| **Pure core** | `models`, `core`, `paths`, `jsonio` | Frozen data + total, deterministic transformations. |
| **Imperative shell** | `client`, `effects`, `orchestrator`, `cli` | Claude Code CLI + disk. All effects are concentrated here. |

`core` stays inside pure modules and frozen Pydantic models. Every decision the
loop makes — what to build, the dependency order, what counts as a blocker, when
to stop, what to fix next — is a pure function over those models. The
orchestrator reaches the outside world through an injected `Effects` bundle, so
**the entire control flow is tested offline against fake effects**
(`tests/test_orchestrator.py`).

## The agent path

| Step | Agent | Model | Writes? | Role |
|------|-------|-------|---------|------|
| 1 | **Zeus** | opus-4-8 | no | architectural plan (PRs, primitives) |
| 2 | **Odysseus** | opus-4-8 | no | decompose into a dependency DAG of slices |
| 3 | **implementers** (parallel by wave) | sonnet-4-6 | yes | Daedalus (feature), Chiron (fix), Prometheus (refactor) |
| 4 | **Athena** ∥ **Hephaestus** | sonnet-4-6 | no | code review ∥ tech-debt audit |
| 5 | **Chiron** (parallel) | sonnet-4-6 | yes | fix the blocking findings → back to step 4 |

The blocking rules (`LoopPolicy`) match the prompts' own `would_approve`
contract: every Athena `critical` blocks; `major` blocks only in
`{type_weakness, concurrency, undefined_behavior}`; Hephaestus debt blocks at
`p0`/`p1`. The loop and the agents agree on what "done" means.

## Layout

```
olympus/
  models.py        frozen typed contracts (wire models + domain models)
  core.py          PURE decisions: blockers, verdict, fix tasks, slice waves, clamps
  paths.py         path sandboxing (no escape past the repo root)
  jsonio.py        robust JSON extraction from model output
  registry.py      the agent roster (model, thinking budget, prompt, access)
  client.py        the Claude Code shell: query loop, write-tracking, JSON parse
  effects.py       the injectable bundle of effectful agent calls
  orchestrator.py  the loop (pure decisions + effectful steps)
  cli.py           command-line entry point
  tests/           107 tests; the core and the loop need no network (live test opt-in)
```

## Design choices worth knowing

- **Changed files are detected by interception.** Olympus watches each agent's
  `ToolUseBlock`s for `Write`/`Edit`/`MultiEdit`/`NotebookEdit` and records the
  paths — it trusts that, not the agent's JSON summary.
- **Dependency-aware implementation.** Odysseus's slices carry `dependencies`;
  `core.slice_waves` (Kahn's algorithm, with cycle detection) groups them into
  waves built in parallel, barrier between waves.
- **Reviews run concurrently.** Athena and Hephaestus are `asyncio.gather`-ed.
- **Thinking budgets are clamped per-call.** The registry mirrors the Claude
  Code subagent configs (1M Opus / 250k Sonnet) as session ceilings;
  `core.clamp_thinking` brings each call to an API-valid `max_thinking_tokens`.
- **Isolated from project settings.** Runs with `setting_sources=None` so a
  repo's own `.claude/` permissions and hooks don't perturb the agents.

## Running it

Olympus uses your Claude Code login.
Use the active Python environment with the dependencies from `pyproject.toml`.

```bash
# from persephone_street/
python -m olympus.cli \
    "Add a fail-closed kill-switch to the order router" \
    --root . --max-iterations 4 --out report.json

# Zeus + Odysseus only — print the slice decomposition, implement nothing:
python -m olympus.cli "@specs/killswitch.md" --dry-run

# let implementers run gates (cargo/pytest) via Bash:
python -m olympus.cli "..." --root . --allow-bash
```

> [!WARNING]
> Full runs allow implementer agents to **write to `--root`** under
> `permission_mode=bypassPermissions`. Point them at a clean branch or worktree,
> review the diff, and run your gates before merging. Olympus drives
> Jane-Street-grade reviewers; CI remains the final merge gate.

## Tests

```bash
# hermetic suite (default) — no network:
python -m pytest olympus/tests -q

# opt-in live test of the real Claude Code driver:
OLYMPUS_LIVE=1 python -m pytest olympus/tests/test_integration_live.py -q
```

The core, path, JSON, model, registry, client-helper, and full-loop tests run
offline. Live Claude Code coverage lives in `test_integration_live.py` and is
enabled with `OLYMPUS_LIVE=1`.
