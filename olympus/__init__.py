"""Olympus — a pure-functional agent orchestration loop over the Persephone pantheon.

Architecture: functional core, imperative shell.

  * ``models``       — frozen, typed contracts (the data).
  * ``core``         — pure decision functions (no I/O, fully unit-testable).
  * ``paths``        — pure filesystem-path sandboxing.
  * ``jsonio``       — pure extraction of JSON from model output.
  * ``registry``     — the agent roster (model, thinking budget, prompt, tools).
  * ``tools``        — effectful file tools exposed to write-mode agents.
  * ``client``       — the Anthropic API shell (caching, thinking, tool loop).
  * ``effects``      — the injectable bundle of effectful agent calls.
  * ``orchestrator`` — the loop: pure decisions, effectful steps.

Nothing in ``core`` imports ``anthropic`` or touches the network or disk. The
loop's correctness is therefore provable offline against fake effects.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
