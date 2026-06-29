# Titan Trader

Titan Trader is a local two-player Next.js trading game. Players take turns narrowing a proposed spread width around AI-generated quantitative items, then one player trades on the accepted width and the other fixes the bid/ask market for settlement.

## Setup

```bash
npm install
cp .env.example .env.local
```

Set `GEMINI_API_KEY` in `.env.local`, then start the app:

```bash
npm run dev
```

Open the local Next.js URL printed by the dev server.

## Gemini Item Generation

The item-generation route uses `@google/genai` from the Next.js server route at `app/api/generate-item`. The Gemini API key is read from the server-only `GEMINI_API_KEY` environment variable and should not be exposed to client-side code.

Generated true values stay in a server-side, process-local round store. The browser receives only a `round_id`, title, category, and clue. Accepted markets are committed through `app/api/commit-market`, and `app/api/settle-round` consumes that committed market to reveal the true value and compute final PnL.

## Gameplay Flow

1. Set up a local two-player game.
2. Generate an item for the round.
3. The starting width owner proposes an opening spread width.
4. The decision player either proposes a tighter width or chooses to trade on the current width.
5. Each valid tighter width swaps the active width owner and decision player.
6. When a player chooses to trade, the last width owner sets a bid/ask exactly matching that width. Entering either bid or ask auto-fills the other side.
7. The trader chooses buy or sell, then settlement uses the server-held true value to compute zero-sum PnL.
8. The next round alternates the starting width owner by round number.
9. The game ends when the configured round count is complete.

## Quality Gates

Run these checks before shipping changes:

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
```
