# Subagent Model Configuration Rule

- **Constraint**: All subagents spawned, defined, or invoked within this project workspace MUST use the **Gemini 3.5 Flash** (Gemini 3.5 Flash (High)) model.
- **Inheritance**: Subagents inherit the active reasoning model from the parent agent. The parent agent's configuration is set to Gemini 3.5 Flash, which ensures model propagation.
- **Optimization**: Prompts and task instructions provided to subagents must be tailored to the reasoning and capability profile of the Gemini 3.5 Flash model.
