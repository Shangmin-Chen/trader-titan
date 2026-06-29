"""The Claude Code shell — drives agents through the user's Claude Code session.

This is the imperative shell. It runs each agent via ``claude_agent_sdk.query``,
which shells out to the ``claude`` CLI and therefore authenticates with the
user's existing Claude Code login — **no ANTHROPIC_API_KEY required**. Agents
use Claude Code's native tools (Read/Grep/Glob, plus Write/Edit for writers);
changed files are tracked by intercepting their ``ToolUseBlock``s.

``AgentRunner.run`` has the same signature it had under the raw-API shell, so the
functional core and the ``Effects`` bundle are unchanged by this swap — the whole
point of keeping decisions pure and effects injected.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    ToolUseBlock,
    query,
)
from pydantic import BaseModel, ConfigDict

from . import core
from .jsonio import JsonExtractionError, extract_json
from .paths import PathEscapeError, resolve_within
from .registry import Access, AgentSpec

# Claude Code native tool names.
READ_TOOLS = ["Read", "Grep", "Glob"]
WRITE_EXTRA = ["Write", "Edit", "MultiEdit"]
# Tool calls that mutate a file — used to attribute changed files to an agent.
WRITE_TOOL_NAMES = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})

# Thinking-budget clamp bounds for the CLI path (output cap ~64k).
_THINK_OUTPUT_CAP = 64_000
_THINK_ANSWER_RESERVE = 4_000
# Safety backstop on agent turns within a single run.
_MAX_TURNS = 200
# Default wall-clock ceiling per agent run, so a hung CLI cannot block forever.
_DEFAULT_TIMEOUT_SECONDS = 600.0


class AgentError(RuntimeError):
    """An agent run failed (CLI error, no result, or unparseable output)."""


class AgentRun(BaseModel):
    """Result of one agent invocation."""

    model_config = ConfigDict(frozen=True)

    parsed: dict
    raw_text: str
    touched_files: tuple[str, ...]


def touched_paths(tool_calls: list[tuple[str, dict]], root: Path) -> tuple[str, ...]:
    """Pure: repo-relative paths of files mutated by the given tool calls.

    Only write tools count. Paths that resolve outside ``root`` or lack a
    file path are dropped. Result is sorted and de-duplicated.
    """
    rootr = root.resolve()
    out: set[str] = set()
    for name, payload in tool_calls:
        if name not in WRITE_TOOL_NAMES:
            continue
        raw = payload.get("file_path") or payload.get("notebook_path") or payload.get("path")
        if not raw:
            continue
        try:
            resolved = resolve_within(root, raw)  # reuse the tested sandbox check
        except PathEscapeError:
            continue  # write landed outside the sandbox root; ignore
        out.add(str(resolved.relative_to(rootr)))
    return tuple(sorted(out))


class AgentRunner:
    """Invokes agents against a repo root via the Claude Code CLI."""

    def __init__(
        self,
        root: Path,
        prompts_dir: Path,
        *,
        permission_mode: str = "bypassPermissions",
        allow_bash: bool = False,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._root = root.resolve()
        self._prompts_dir = prompts_dir
        self._permission_mode = permission_mode
        self._allow_bash = allow_bash
        self._timeout_seconds = timeout_seconds

    def _tools(self, access: Access) -> list[str]:
        tools = list(READ_TOOLS)
        if access is Access.WRITE:
            tools += WRITE_EXTRA
        if self._allow_bash:
            tools.append("Bash")
        return tools

    def _options(self, spec: AgentSpec) -> ClaudeAgentOptions:
        return ClaudeAgentOptions(
            system_prompt=spec.system_prompt(self._prompts_dir),
            model=spec.model,
            allowed_tools=self._tools(spec.access),
            permission_mode=self._permission_mode,
            cwd=str(self._root),
            setting_sources=None,  # isolate from project/user settings & CLAUDE.md
            max_thinking_tokens=core.clamp_thinking(
                spec.thinking_budget, _THINK_OUTPUT_CAP, _THINK_ANSWER_RESERVE
            ),
            max_turns=_MAX_TURNS,
        )

    async def run(self, spec: AgentSpec, user_prompt: str) -> AgentRun:
        """Drive ``spec`` to a final JSON answer; retry once for JSON-only.

        Files written across BOTH the first attempt and the repair attempt are
        accumulated into ``touched``, so a JSON parse failure mid-write never
        loses the attribution of files the agent actually changed.
        """
        touched: set[str] = set()
        result = await self._drive(spec, user_prompt, touched)
        try:
            parsed = extract_json(result.result or "")
        except JsonExtractionError:
            repair = (
                user_prompt + "\n\nIMPORTANT: Reply with ONLY the JSON object specified in your "
                "instructions — no prose, no markdown fence."
            )
            result = await self._drive(spec, repair, touched)
            parsed = extract_json(result.result or "")  # propagates if still unparseable
        return AgentRun(
            parsed=parsed,
            raw_text=result.result or "",
            touched_files=tuple(sorted(touched)),
        )

    async def _drive(self, spec: AgentSpec, user_prompt: str, touched: set[str]) -> ResultMessage:
        """Run one agent turn-loop, recording writes into ``touched``.

        Returns the final ResultMessage (raising AgentError if it is missing or
        flags an error). The query generator is always closed — including on
        timeout — so the underlying CLI subprocess is not left dangling.
        """
        options = self._options(spec)
        result: ResultMessage | None = None
        agen = query(prompt=user_prompt, options=options)
        try:
            async with asyncio.timeout(self._timeout_seconds):
                async for message in agen:
                    if isinstance(message, AssistantMessage):
                        calls = [
                            (b.name, b.input)
                            for b in message.content
                            if isinstance(b, ToolUseBlock)
                        ]
                        touched.update(touched_paths(calls, self._root))
                    elif isinstance(message, ResultMessage):
                        result = message
        except TimeoutError as exc:
            raise AgentError(f"{spec.name}: timed out after {self._timeout_seconds:.0f}s") from exc
        finally:
            aclose = getattr(agen, "aclose", None)
            if aclose is not None:
                await aclose()

        if result is None:
            raise AgentError(f"{spec.name}: no result message from CLI")
        if result.is_error:
            detail = result.errors or result.subtype
            raise AgentError(f"{spec.name}: CLI reported error: {detail}")
        return result
