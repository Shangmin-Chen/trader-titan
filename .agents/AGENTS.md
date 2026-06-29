# Trader Titan Agent Rules

This file defines the project-scoped rules for agents and subagents operating within the Trader Titan workspace.

## Subagent Spawn Model
- All subagents spawned, defined, or invoked for this project workspace must use the **Gemini 3.5 Flash** (or **Gemini 3.5 Flash (High)**) model.
- Since subagents inherit the model from the parent agent, and the primary session/project model is configured to use Gemini 3.5 Flash, all subagents will automatically run on Gemini 3.5 Flash.
- Ensure that any prompt, system instructions, or task definitions provided to subagents (via `invoke_subagent` or `define_subagent`) are optimized for and compatible with the reasoning capabilities of Gemini 3.5 Flash.
