# Titan Trader

Titan Trader is a local two-player Next.js trading game. Players take turns narrowing a proposed spread width around AI-generated quantitative items, then one player trades on the accepted width and the other fixes the bid/ask market for settlement.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run preview:cloudflare
```

Open the local Wrangler URL printed by the dev server. The multiplayer room
flow depends on Worker routes and Durable Objects, so `npm run dev` is useful
for isolated Next.js UI work but not for the full invite-room game.

## Gemini Item Generation & Config

Worker item generation uses `@google/genai/web` from the Durable Object room lifecycle, with shared provider code under `src/api/item-generation`. The Gemini API key is read from the server-only `GEMINI_API_KEY` Worker secret and should not be exposed to client-side code. For local Wrangler preview without Gemini, keep `WORKER_ITEM_PROVIDER=deterministic` in `.dev.vars`.

- **Amazon Market Config**: In [gemini-markets.json](config/gemini-markets.json), the guidance instructs Gemini to vary the types of items generated for the Amazon mode, including:
  - Normal consumer electronics (e.g. iPad, PlayStation)
  - Luxury/premium products (e.g. Herman Miller Aeron, Tumi suitcase)
  - Funny and unhinged real Amazon items (e.g. Nicolas Cage mermaid pillow, Yodelling pickled cucumber)

Generated true values live in `GameRoomDurableObject` private storage. The browser receives only a `round_id`, title, category, and clue until settlement. The Worker blocks legacy process-local game API routes in Cloudflare, and the UI sends gameplay commands through `/api/rooms`.

## Amazon Organic Scraper & Custom Query Toggle

- **Organic Price Parsing**: The Amazon scraper parses organic search results (filtering out sponsored ads) to find the first result's price as the source of truth (`true_value`).
- **Post-Settlement Scraper Breakdown**: Upon round settlement, a premium UI panel displays:
  - An **Amazon Source Link** to view the live search results on Amazon.
  - A stylized list of **Scraped Listings** with prices from the search grid, clearly indicating which listing was used as the source of truth.
- **Custom Query Toggle**: The game setup form provides a checkbox toggle: **"Player-entered Amazon product query"**. When enabled:
  - In Round 1, **Player A** enters their own Amazon search term/query (while Player B looks away), and **Player B** proposes the spread width.
  - In Round 2, **Player B** enters the query, and **Player A** proposes the width.
  - The scraper fetches the price and lists the results live, making it a player-driven guessing game.

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
