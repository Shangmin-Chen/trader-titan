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

No secrets are required anywhere in setup or deployment: there is no external AI provider and no search layer. All items come from a static deck.

## Static Market Deck

Items are drawn entirely from [config/static-markets.json](config/static-markets.json) (four modes × ten items each, `true_value` included). The server picks each round's item with a pure function - deck index `(roundNumber - 1) % deck.length` (`itemForRound` in `src/worker/static-deck.ts`) - so item delivery can never fail mid-round and settlement is synchronous with the trade. Room config validation caps `totalRounds` at the live deck length, so a match can never repeat an item within itself; items do repeat across rematches (accepted MVP tradeoff - add deck rows if variety matters).

Because the deck pick is pure and recomputable at settle time, no private item storage exists between rounds: the browser receives only a `round_id`, title, category, and clue until settlement. The Worker blocks legacy process-local game API routes in Cloudflare, and the UI sends gameplay commands through `/api/rooms`.

Role calendar note: every mode now follows the same alternating calendar - Player A proposes width in odd rounds, Player B in even rounds. (Previously rooms carried a custom-query flag that swapped roles differently per round.)

## Gameplay Flow

1. The host creates a room, shares the invite link, and waits for player B.
2. The host starts the room after the guest joins; the first item is dealt immediately.
3. The starting width owner proposes an opening spread width.
4. The decision player either proposes a tighter width or chooses to trade on the current width.
5. Each valid tighter width swaps the active width owner and decision player.
6. When a player chooses to trade, the last width owner sets a bid/ask exactly matching that width. Entering either bid or ask auto-fills the other side.
7. The trader chooses buy or sell, then settlement uses the static deck's true value to compute zero-sum PnL synchronously with the trade.
8. The next round alternates the starting width owner by round number.
9. The game ends when the configured round count is complete. The host can reset to the lobby or kick the guest to free the invite slot.

There is no turn timer: an idle opponent stalls only their own turn until the host resets the lobby or kicks them.

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

After changing `wrangler.toml`/`.dev.vars.example`, regenerate the Worker environment types with `npm run typegen:worker`.

## Release Notes

- **Per-phase room invalidation on deploy:** persistence envelope versions hard-cutover per phase (v4 → v5 → v6) with no migration path. Deploying a phase invalidates every live room still inside the ≤2 h abandoned-room TTL window; affected players simply start a new room. This is deliberate policy, not a bug.
- **One-time secret cleanup:** after deploying, remove the now-unused Gemini credential from your Cloudflare account with `wrangler secret delete GEMINI_API_KEY`.
- **Asymmetric-revert caveat:** reverting an earlier cleanup phase after later ones have landed restores an older decoder whose minimum supported version rejects newer envelopes - post-cutover rooms then fail decode and purge on first touch. Emergency-only; pair any revert with an immediate re-forward-fix.

The Cloudflare build script no longer clears server secrets from the build environment or scans generated `.open-next` artifacts for known secret values - its only tracked secret was removed with the AI provider. If future secrets appear, reinstate equivalent blanking/scanning in `scripts/build-cloudflare.mjs`.
