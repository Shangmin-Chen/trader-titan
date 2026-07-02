# Item Generation Spec

Item generation is split into provider logic and route/runtime boundaries.

## Provider Contract

Providers return either a private `ProviderGeneratedItem` or a typed `ItemGenerationError`. Private generated items include `true_value`; public route responses must never include it before settlement.

The provider JSON parser accepts only objects with exactly:

- `item_title`
- `category`
- `context_clue`
- `true_value`

String fields are trimmed and must be non-empty. `true_value` must be finite and within the playable range.

## Gemini Provider

The Gemini provider owns prompt construction, response schema configuration, and typed provider failure mapping. It receives API keys from route/runtime code, never directly from process env.

Gemini prompt construction is shared by the Node API path and the Cloudflare Worker path. Shared prompt/config modules must not import `@google/genai` or `@google/genai/web`; runtime-specific Gemini clients stay at the Node API or Worker boundary. Both runtime paths use `config/gemini-markets.json` for market guidance, including Amazon's mix of funny/unhinged, normal electronics, and luxury/premium product instructions.

## Amazon Provider

Amazon mode may replace a generated item value with a fetched Amazon price. Custom Amazon queries must be strings, trimmed, non-empty, and at most 200 characters.

Amazon lookup failures return typed errors rather than throwing through route handlers.
