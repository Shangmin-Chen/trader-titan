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

## Gemini Item Generation & Config

The item-generation route uses `@google/genai` from the Next.js server route at `app/api/generate-item`. The Gemini API key is read from the server-only `GEMINI_API_KEY` environment variable and should not be exposed to client-side code.

- **Amazon Market Config**: In [gemini-markets.json](file:///Users/shangminchen/trader-titan/config/gemini-markets.json), the guidance instructs Gemini to vary the types of items generated for the Amazon mode, including:
  - Normal consumer electronics (e.g. iPad, PlayStation)
  - Luxury/premium products (e.g. Herman Miller Aeron, Tumi suitcase)
  - Funny and unhinged real Amazon items (e.g. Nicolas Cage mermaid pillow, Yodelling pickled cucumber)

Generated true values stay in a server-side, process-local round store. The browser receives only a `round_id`, title, category, and clue. Accepted markets are committed through `app/api/commit-market`, and `app/api/settle-round` consumes that committed market to reveal the true value and compute final PnL.

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

1. Set up a local two-player game (optionally enabling Custom Amazon Queries if playing in Amazon mode).
2. Generate/input the item for the round.
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
