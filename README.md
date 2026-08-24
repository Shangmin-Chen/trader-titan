# Titan Trader

Titan Trader is a local two-player Next.js trading game. Players take turns narrowing a proposed spread width around quantitative items drawn from a built-in static deck, then one player trades on the accepted width and the other fixes the bid/ask market for settlement.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run preview:cloudflare
```

Open the local Wrangler URL printed by the dev server. The multiplayer room
flow depends on Worker routes and Durable Objects, so `npm run dev` is useful
for isolated Next.js UI work but not for the full invite-room game.

## Item Generation

Items are drawn from a static deck ([config/static-markets.json](config/static-markets.json)); no external AI provider or secrets are used.

`WORKER_TEST_MODE` is a separate, narrower var: it gates only the test-only `POST /api/rooms/:id/test-expire-turn` route (see `testExpireTurnSoon` in `src/worker/index.ts`), which lets a caller fast-forward a room's turn clock. It has no other meaning anywhere in this codebase and is never read outside that one gate. Only `npm run test:e2e`'s own `wrangler dev` invocation (see `playwright.config.ts`) sets it - do not add it to `.dev.vars` or `wrangler.toml`.

Generated true values live in `GameRoomDurableObject` private storage. The browser receives only a `round_id`, title, category, and clue until settlement. The Worker blocks legacy process-local game API routes in Cloudflare, and the UI sends gameplay commands through `/api/rooms`.

## Gameplay Flow

1. The host creates a room, shares the invite link, and waits for player B.
2. The host starts the room after the guest joins.
3. Generate/input the item for the round.
4. The starting width owner proposes an opening spread width.
5. The decision player either proposes a tighter width or chooses to trade on the current width.
6. Each valid tighter width swaps the active width owner and decision player.
7. When a player chooses to trade, the last width owner sets a bid/ask exactly matching that width. Entering either bid or ask auto-fills the other side.
8. The trader chooses buy or sell, then settlement uses the server-held true value to compute zero-sum PnL.
9. The next round alternates the starting width owner by round number.
10. The game ends when the configured round count is complete. The host can reset to the lobby or kick the guest to free the invite slot.

## Quality Gates

Run these checks before shipping changes:

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run worker-test
npm run build:cloudflare
```

For Cloudflare builds, keep `GEMINI_API_KEY` out of Next `.env*` files and use Wrangler secrets or `.dev.vars` for local preview. The Cloudflare build script clears server secrets from the build environment and fails if generated `.open-next` artifacts contain known secret values.
