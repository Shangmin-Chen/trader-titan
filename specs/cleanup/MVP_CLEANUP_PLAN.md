# Trader Titan MVP Cleanup & Migration Plan

**Status:** EXECUTION-READY v4 — review loop converged (0 blockers / 0 majors outstanding). Owner decisions locked 2026-08-24: **D1 = CUT shot clocks · D3 = plain-modulo pick + totalRounds cap · D4 = delete Amazon deck section**. See Revision History (§9).
**Date:** 2026-08-23
**Scope:** Cut the AI item-generation layer (Gemini), the search layer (Amazon scraper + custom-query flow), the provider-failure/retry machinery, the shot-clock layer (default = cut, see Open Decisions), and repo junk. Keep the turn-based multiplayer core on a static item deck.
**Rule:** This plan changes no behavior of the KEEP surface except where a CUT removes something it depended on. Every phase ends green on `npm run lint && npm run typecheck && npm test && npm run worker-test` (+ `npm run build:cloudflare`, and `npm run test:e2e` from Phase 1+2 onward — **main is never red**, see Phase structure).

---

## 1. Executive summary

Trader Titan is being reduced to its MVP: two players negotiate a spread, one makes a market, one trades, the server settles zero-sum PnL — with items drawn from `config/static-markets.json` (5 modes × 10 items, true_values included) instead of Gemini + Amazon scraping.

The load-bearing discovery from investigation: **once items come from the static deck via a pure function, the entire "async effect" architecture becomes unnecessary.**

- Today: `START_ROOM`/`ADVANCE_ROUND` commit a `generatingItem` room, the Worker pre-generates all rounds' items outside the storage transaction (`pregenerateAllItems`, src/worker/index.ts:1552), stores them privately (`room:pregenerated-items:v1`, `room:private-generated-item:v1:*`), and settlement later resumes from that stored private item inside `settling` — which is why F-02's pending-effect marker, alarm retry/backoff (`PENDING_SETTLE_EFFECT_*`, ~400 lines), F-07's episode cap/bounce logic, `RETRY_ITEM_GENERATION`, and `SETTLEMENT_FAILED` exist at all.
- After: `itemForRound(mode, roundNumber)` is pure (deck pick, see Open Decision D3 for the exact derivation). The Worker composes transitions **inside a single storage transaction**: `START_GAME → ITEM_RECEIVED(deckItem)`, `NEXT_ROUND → ITEM_RECEIVED(deckItem)`, `EXECUTE_TRADE → SETTLEMENT_RECEIVED(computedSettlement)`. Nothing async can fail mid-round, so:
  - private generated-item storage is deleted outright (`src/worker/private-generated-items.ts`, both storage key families),
  - `generatingItem` and `settling` become **transient-only phases** — never persisted, never broadcast,
  - `PendingRoomEffect`, backoff constants, `runDueSettleEffect`, `forceFailStuckSettlement`, `SETTLEMENT_FAILURE_EPISODE_CAP`, `lockedPendingTrade`, `settlementFailureCount`, `SETTLEMENT_FAILED`, `ITEM_FAILED`, and the `RETRY_ITEM_GENERATION` command are deleted end-to-end,
  - the DO alarm multiplexer reduces to **TTL + (F-08) socket liveness** (+ turn clock if shot clocks are KEPT).

Estimated net deletion: **~7,500–9,500 lines** in tracked files (src + tests + e2e + config), 1 runtime dependency, plus the untracked `persephone/` tree.

### Goals

1. One item source: `config/static-markets.json`, loaded server-side only (verified: only import site is src/worker/index.ts:73; non-Amazon deck items carry exactly the four core keys `item_title/category/context_clue/true_value` — i.e. already match `Omit<ProviderGeneratedItem,"round_id">` with no optional scraped fields).
2. Zero external I/O anywhere in the round loop; settlement is synchronous with `EXECUTE_TRADE`.
3. Delete the custom-Amazon query flow across protocol → persistence → snapshot → UI → e2e.
4. Delete provider-failure machinery (F-02 marker/retry, F-07 bounce cap) — it has no failure class left to handle.
5. Execute the shot-clock decision (Open Decision D1; default = cut) cleanly, including `/room/test-expire-turn` and `WORKER_TEST_MODE`.
6. Repo hygiene: delete `persephone/` (local junk) and `PR_BODY.md` (tracked, 440 lines / 34,551 bytes), strip Gemini secrets plumbing, remove the pre-existing dead `SERVER_PRESENCE_LIVENESS_TIMEOUT_MS` constant.
7. Keep quality gates meaningful: e2e rewrites land **in the same PR** as the server deletions they track; main never ships with failing gates.

### Non-goals

- No redesign of the WebSocket protocol envelope (`tt-room-v1`), capability tokens, dedupe, hibernation, or the F-08 liveness sweep — all survive untouched.
- No new features, no restyling, no changes to scoring math (`settlement.ts` stays as-is minus forfeit/forced-side helpers if D1 = cut).
- No attempt to preserve live-room compatibility across deploys (per-phase hard cutovers; see Risk R1/R2).
- Not touching `prompts/` (verified: zero references to F-numbered machinery), `.agents/`, `.claude/`, `.codex/`.

---

## 2. Open decisions

### D1 — Shot clocks (F-05/F-06): **DECIDED: CUT** (owner, 2026-08-24)

Everything needed: per-phase `turnDeadlineMs` (4 phase states), `TURN_EXPIRED`, `expireRoomTurn`, `test-expire-turn` route + `WORKER_TEST_MODE` gate + Playwright fast-forward, `RoundForfeitPanel`, `TurnCountdown`, `roundForfeited` phase, `RoundForfeit`, `applyForfeitToScores`, `PROPOSING_WIDTH_FORFEIT_PENALTY`, the four `*_TURN_DURATION_MS` constants, F-06's `PendingTradeDecision.timeoutForcedWorstSide` / `resolvePendingTradeSide` / `forcedByTimeout`, `turn-clock-recovery-budget.test.ts`, and specs sections.

| | KEEP | CUT (recommended) |
|---|---|---|
| Stalls/griefing protection | Yes — a player who walks away can't freeze the round forever | Lost — a missing player stalls their own turn indefinitely; opponent's recourse is host RESET_TO_LOBBY/KICK_GUEST |
| Alarm complexity after Phase 3 | TTL + liveness + turn clock | TTL + liveness |
| Code touched | ~150 lines | ~800–1,000 lines incl. tests/e2e |
| MVP fit | Arguable | Matches "alarm() reduces to TTL-only" direction |

**DECIDED: CUT** (owner, 2026-08-24 — supersedes the earlier "default" framing). An MVP for friends-matches tolerates "nudge your opponent"; the shot clock is the largest complexity block left after Phases 1–3, and cutting it also deletes the test-only expire route (an auth-sensitive surface, src/worker/index.ts:715–802) and its `WORKER_TEST_MODE` gate. If wanted later, re-introduction is additive and well-understood. **Phase 4 below executes CUT; a KEEP variant is sketched there too.**

Sub-decision D1a — **FORCED, not optional (v2):** once `turnDeadlineMs` dies, `TurnCountdown` has no data source. It is deleted along with its test and its `components/index.ts` barrel export (:19). The original draft listed TurnCountdown on the KEEP list; the cut direction overrides that. No owner input required.

### D2 — Persistence backward compatibility: hard cutover, per-phase bumps. **FORCED by repo policy (v2 refinement)**

persistence.ts:80–87 documents the invariant: any change to a phase's persisted keys requires a version bump, and readers must accept every version ≥ floor. Because Phases 1+2 / 3 / 4 each change persisted shapes while earlier phases' machinery may still be live in production between deploys, we bump **once per phase that changes storage**:

- **v4 @ Phase 1+2** (config flags + scraped fields leave the envelope; migration chain v1→v3 deleted),
- **v5 @ Phase 3** (`generatingItem`/`settling`/`error` stop being persistable; `lockedPendingTrade`/`settlementFailureCount` leave `choosingSide`),
- **v6 @ Phase 4-CUT** (`roundForfeited` stops being persistable; forfeit/forced-timeout fields leave settlement records).

Each bump sets `ROOM_PERSISTENCE_VERSION = n` **and `ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION = n`** (hard cutover — no cross-version migration is written at any point). Any older envelope fails decode → existing self-heal paths purge it and the room reads as never-created (proven by worker tests at index.worker-test.ts:3356, 3409, 3099). Blast radius per deploy: rooms live in the ≤2 h TTL window (persistence.ts:49–59). Accepted; release-noted per phase.

Without the per-phase bumps, a mid-train deploy of Phase 3 alone would brick live v4 rooms sitting in `settling` (the decode case would be gone before async settlement machinery finished dying) — this sequencing closes that hole.

### D3 — Item derivation: pure function. **DECIDED: plain modulo pick + rounds cap** (owner, 2026-08-24)

The random-shuffle + private-storage alternative (today's behavior) reintroduces `private-generated-items.ts` and the settle-resume problem — negating Phases 1 and 3. Generation MUST stay a pure function recomputable at settle time. Owner decision (2026-08-24): take the simplest variant —

- `itemForRound(mode, roundNumber) = staticMarkets[mode][(roundNumber - 1) % deck.length]`
- Config validation caps `totalRounds` at the live deck length (`maxRoundsForDeck()` derived from the loaded deck, never hardcoded): a match can never outlive its item variety, so in-match repeats are impossible.
- Cross-match repetition is an accepted MVP tradeoff: any scheme reuses the same 50 items across rematches, so item secrecy buys nothing. If repetition ever bothers playtesters, the remedy is adding rows to `static-markets.json`, not cryptography.

Rejected for the record: the HMAC-offset variant (v2's recommendation) was withdrawn as over-engineering for this game's threat model; uncapped modulo (v1) was rejected because rounds 11+ would repeat revealed true values. `static-deck.ts` exposes one seam (`itemForRound`) so revisiting later is a one-file change.

### D4 — `Amazon` mode entry & deck section. **DECIDED: delete the section** (owner, 2026-08-24)

Cut list removes `"Amazon"` from `GAME_MODES`; the deck's `"Amazon"` section (static-markets.json:250–332, ~83 lines) is deleted with it. `validateStaticDeck()` still scopes validation to `GAME_MODES` members, so any future extra section cannot silently break boot.

### D5 — Role-calendar behavior change (documented, not open)

Today `customAmazonQuery` defaults to **true** for every room (`normalizeRoomConfig`, commands.ts:708–718) and drives TWO swaps: round 1 starts with roles swapped (reducer.ts:305) and **every** `NEXT_ROUND` swaps again (reducer.ts:786) — so in current default matches, Player B proposes width in odd rounds. Cutting the flag moves all modes onto `rolesForRound()`: Player A proposes odd rounds. This changes the proposer calendar of every default match, not just former-custom ones. Document in release notes; nobody should "fix" it back.

---

## 3. Phase structure & execution order

```
P0        Eject repo junk + dead code      (trivially safe, independent)
P1+2      Static-deck provider AND strip   (ONE changeset — merged per review F1;
           custom-amazon/AI flags           UI, route, and provider die together)
P3        Synchronous settlement           (depends on P1+2)
P4        Shot-clock decision execution    (depends on P3)
P5        Docs/specs/tests final sweep     (full gates + manual matrix)
```

**Stacked PR train `[P0] [P1+2] [P3] [P4] [P5]` — never one mega-PR (review B8).** Each branch stacks on the previous; each lands green.

Why P1+P2 are inseparable: `normalizeRoomConfig` unconditionally defaults `customAmazonQuery: true` (commands.ts:708–718), so after a provider-only Phase 1 the deployed UI renders `CustomAmazonQueryForm` against a dead route and e2e fails — shipping that to main violates the never-red rule and strands real users on a broken screen. The provider surface cannot be half-deleted anyway (`/room/custom-amazon-item` depends on `amazon-provider.ts`, which shares `item-provider.ts` with standard generation), so route + provider + UI + flags go in one reviewable changeset with its e2e rewrite.

Why P3 needs P1+2: synchronous composition requires the pure deck. Why P4 needs P3: F-06's choosingSide-timeout currently writes a pending settle effect from the alarm path (index.ts:1113–1151); that coupling must be gone before the shot-clock layer lifts out. Why P5 is last: earlier phases update docs/tests they touch; P5 is coherence + full-gate + manual matrix.

---

## 4. Phase details

### Phase 0 — Eject repo junk & pre-existing dead code

**Delete**
- `persephone/` — untracked local directory, gitignored (.gitignore line 5), never tracked in any of 103 commits. Action: `rm -rf persephone` (disk only). Check whether the `.gitignore` line existed solely for this path before removing the line.
- `PR_BODY.md` — **tracked** (`git ls-files` confirms), 440 lines. Action: `git rm PR_BODY.md`. NOTE: referenced by comments in `src/worker/entrypoint-exports.worker-test.ts` (~lines 20–24, "see PR_BODY.md for the incident…") — those comments are reworded in P5 (A9); they degrade gracefully until then.
- `SERVER_PRESENCE_LIVENESS_TIMEOUT_MS` — pre-existing dead export in `src/lib/room-socket-supervisor.ts:184` (verified zero consumers). Folded into P0 per review B6.

**Tests/gates:** `npm run lint` + `npm run typecheck` + confirm `git status` shows only intended changes.

---

### Phase 1+2 — Static-deck provider replaces gemini+amazon AND strips the custom-Amazon flow & AI flags

Goal: `START_ROOM`/`ADVANCE_ROUND` synchronously attach a deck item in the same transaction; every provider file, `@google/genai`, the custom-amazon route/form/flags, and all scraped-field plumbing disappear in one changeset. First storage break ⇒ **persistence v4 hard cutover here** (D2).

**New code**

- `src/worker/static-deck.ts` (new, ~60 lines):

```ts
import deck from "../../config/static-markets.json";
import type { GameMode, ProviderGeneratedItem } from "../lib/game";

type DeckItem = Omit<ProviderGeneratedItem, "round_id">;
const STATIC_DECK = deck as Record<GameMode, DeckItem[]>;

// D3 (decided): plain modulo pick behind this single seam:
export function itemForRound(mode: GameMode, roundNumber: number): DeckItem;
export function maxRoundsForDeck(): number;
export function validateStaticDeck(): void;
// validateStaticDeck asserts: every GAME_MODES member maps to a non-empty array;
// every item has exactly the 4 required keys; true_value finite and
// |true_value| <= MAX_PLAYABLE_ABSOLUTE_VALUE. Scoped to GAME_MODES members
// (D4 decided: the Amazon section is deleted from the deck JSON).
// maxRoundsForDeck() returns the deck length; config validation caps
// totalRounds at this value so a match can never exceed item variety (D3).
```

Called once at module init; throws at boot on a malformed deck.

**Modify — `src/worker/index.ts`**
- Replace imports (lines 60–81): drop `createWorkerRoomItemProviders`, `itemGenerationErrorMessage`, `GoogleGenAI`, `marketConfig`, GEMINI_* imports, `createFetchAmazonLookup`; import from `./static-deck`.
- Collapse the generation branch of `applyAutomaticRoomEffects` (1478–1550) into `receiveDeckItem(room, nowMs)` composing `ITEM_RECEIVED` with `itemForRound(...)` against the freshly-loaded room, same transaction shape as `receiveGeneratedProviderItem` minus credentials.
- Delete `pregenerateAllItems` (1552–1695) incl. Gemini batch branch and `"room:pregenerated-items:v1"` read/write; delete the `isTestEnv`/`WORKER_ITEM_PROVIDER` gate (1484–1486).
- Delete the custom-amazon path entirely (route shell does NOT survive the merge): `applyCustomAmazonItem` (625–677), DO fetch branch (396–398) + 405-list mention (409), public router branch (2466–2483), `ROOM_CUSTOM_AMAZON_ITEM_ENDPOINT` (92), `PUBLIC_CUSTOM_AMAZON_ITEM_ROUTE` (96), `publicRoomCustomAmazonRateLimiter` (154), `loadCustomAmazonGenerationTarget` (1697–1733), `authorizeCustomAmazonGeneration` (2629–2656), `decodeCustomAmazonItemBody` (2964–2990), `CustomAmazonItemResponse`/`CustomAmazonItemBody` (212–233), `statusForItemGenerationError` (3481–3494), `isCustomAmazonGenerationPending` (2596–2600) + its use in `shouldGenerateItemAfterCommand` (2593), and simplify `generationTargetForRoom`/`samePendingGeneration` (2602–2627) to whatever the synchronous flow needs (likely fully deletable). `LEGACY_NEXT_GAME_API_PATHS` already contains `/api/generate-custom-amazon-item` — keep the set as-is (it now serves only to 410 the legacy Next path).
- `deletePrivateGeneratedItems` (3220): drop `"room:pregenerated-items:v1"` from the key list (the private-item prefix itself survives until P3 for legacy settle resume).

**Delete files**
- `src/api/item-generation/` entire directory (9 files, 1,113 lines): `amazon-provider.ts` (270), `config.ts` (146), `gemini-provider.ts` (110), `provider-json.ts` (92), `provider.test.ts` (291), `import-boundaries.test.ts` (64), `index.ts` (50), `types.ts` (63), `test-provider.ts` (27).
- `src/worker/item-provider.ts` (141), `src/worker/item-provider.test.ts` (140).
- `config/gemini-markets.json`; `config/static-markets.json` `"Amazon"` section (lines 250–332, ~83 lines) per D4-recommended.
- `src/components/CustomAmazonQueryForm.tsx` (80) **and `src/components/CustomAmazonQueryForm.module.css` (12)** (A8).

**Modify — game domain**
- `src/lib/game/types.ts`: remove `"Amazon"` from `GAME_MODES`; delete `ScrapedAmazonItem`; drop `scraped_items?`/`amazon_url?` from `ProviderGeneratedItem`/`SettledGeneratedItem`; drop `customAmazonQuery`/`aiGenerated` from `GameStateBase` and `StartGamePayload`.
- `src/lib/game/reducer.ts`: remove flag threading + role-swap-on-flag in START_GAME (301–305), RETRY_ITEM_GENERATION (366), EXECUTE_TRADE (516–521), SETTLEMENT_RECEIVED (558), SETTLEMENT_FAILED (605–611, 644–649), TURN_EXPIRED (732–737), NEXT_ROUND (782–786) — uniform `rolesForRound()` calendar per D5.
- `src/lib/game/validation.ts`: mode check auto-narrows via narrowed `GAME_MODES`; no other edits needed.

**Modify — room protocol/domain**
- `src/lib/room/types.ts`: drop both flags from `RoomGameConfig` (22–23).
- `src/lib/room/protocol.ts`: `CONFIG_KEYS` → `["mode","totalRounds"]` (28); delete `customAmazonQuery` decode (635–645) + `aiGenerated` equivalent; settled-item allowlist loses `scraped_items`/`amazon_url` (40–41); item decode drops both arms (754–770). Effect: old clients POSTing the flags get a decode error (400) — accepted strictness (Risk R2).
- `src/lib/room/commands.ts`: `startPayloadForRoom` (694–695) drops flags; `normalizeRoomConfig` (699–719) collapses to `{mode,totalRounds}`; `validateRoomConfig` drops flag.
- `src/lib/room/snapshot.ts`: drop `customAmazonQuery` passthrough (299–301) and `scraped_items`/`amazon_url` from `PublicSettledGeneratedItem` (68–69) + builder (362–370); drop `aiGenerated`.
- `src/lib/room/persistence.ts` — **v4 cutover**: `ROOM_PERSISTENCE_VERSION = 4`, `ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION = 4`; delete `migrateGameStateRecordForward` + `migrateV1ToV2/V2ToV3*` + helpers `withFreshTurnDeadline`/`withMigratedPendingTrade`/`withDefaultedForcedByTimeout`/`withDefaultedSettlementFailureCount` (~413–585 region); collapse `DecodeContext.version` special-casing (304–313); `decodeRoomGameConfig` (246–271) loses flag checks/outputs; item validators lose `isScrapedAmazonItems` + scraped/amazon arms (~678–705).
- `src/lib/room/index.ts`: adjust exports for removed symbols.

**Modify — request guards**
- `src/api/request-guards.ts`: delete `createRoomCustomAmazonRateLimiter` + `ROOM_CUSTOM_AMAZON_RATE_LIMIT_*` (22–24, 70–79); also delete `createItemGenerationRateLimiter` + `ITEM_GENERATION_RATE_LIMIT_*` (16–18, 48–57) — grep confirms remaining callers die with this phase.

**Modify — client/UI**
- `src/components/index.ts`: remove `export * from "./CustomAmazonQueryForm"` (line 11) **in the same commit as the component deletion** (A2 — otherwise TS2307).
- `src/components/ItemPanel.tsx`: strip the scrape-display surface from the component itself (A6): `scrapedItems`/`amazonUrl` extraction (19–27), "Amazon Source Link" `<dt>`/link block (49–65), scraped-listings `<dl>` block (66–93+).
- `src/components/ItemPanel.test.tsx`: delete scrape-display cases (12–53).
- `src/app/globals.css`: delete `.amazon-link` rules and `.scraped-items-list` family (2011–2077).
- `src/components/ItemPanel.module.css`: delete `.scrapedDetail` (5) and `.scrapedItem` (19+) classes. (v1 wrongly cited page.module.css.)
- `src/lib/room-client.ts`: delete `submitCustomAmazonItem` (235–241), `CustomAmazonItemRequest` (88–91).
- `src/app/page.tsx`: remove `CustomAmazonQueryForm` import + generatingItem custom branch (1429–1441), `isGeneratingCustomItem` state + `handleCustomAmazonQuerySubmit` (205, 686–706), AI checkbox in CreateRoomPanel (998–1012), flags in `buildStartPayload` (2064–2084).
- **Invalidated-room client handling (B5):** extend command/access error handling so `room_not_found` (404) and `persistence_version_unsupported` (now 410, below) clear the stored session (`clearRoomSession`), close the supervisor socket, and render a "This room has ended — start a new one" CTA instead of leaving a tab frozen at connectionStatus "Live" (page.tsx lenient parse 2117–2147, revision guard 1897–1924 currently mask the death).

**Modify — env/config/plumbing (complete WORKER_ITEM_PROVIDER + GEMINI removal, A7)**
- `package.json`: remove `"@google/genai"`; regenerate lockfile.
- `.dev.vars.example`: remove `GEMINI_API_KEY=` **and** `WORKER_ITEM_PROVIDER=`.
- `.env.example`: remove `GEMINI_API_KEY` line (file becomes empty → delete).
- `vitest.worker.config.ts`: drop `GEMINI_API_KEY`/`WORKER_ITEM_PROVIDER` miniflare bindings (~36–37).
- `playwright.config.ts`: webServer command drops `--var WORKER_ITEM_PROVIDER:deterministic` (line 26); keeps `WORKER_TEST_MODE:1` until P4.
- `.github/workflows/ci.yml`: update the e2e job comment (lines ~110–117) that references the `WORKER_ITEM_PROVIDER:deterministic` var and GEMINI blanking.
- `scripts/build-cloudflare.mjs`: remove `SECRET_KEYS`/blanking loop (17–24) and the artifact secret-scanning mechanism (36–129, ~95 lines) — its only secret is gone; note in README how to reinstate if future secrets appear (Risk R8).
- `worker-configuration.d.ts`: regenerate via `npm run typegen:worker` after cleaning `.dev.vars.example`; verify `GEMINI_API_KEY`/`WORKER_ITEM_PROVIDER` gone.
- Local untracked `.dev.vars`/`.env.local`: advise owner; don't touch in-repo. Deployment: `wrangler secret delete GEMINI_API_KEY` (release-noted in P5).

**Tests**
- Delete: `src/worker/item-provider.test.ts`, `src/api/item-generation/provider.test.ts`, `src/api/item-generation/import-boundaries.test.ts`.
- `src/worker/index.worker-test.ts`: rewrite generation suites around synchronous receipt — "auto-generates an item when retrying…" (884), "records an error when retry provider generation fails…" (945), "rejects guest item-generation retries…" (1026) become START_ROOM/ADVANCE_ROUND-deck coverage; delete custom-Amazon suites (3531, 3617, 3715) and the public rate-limit suite for that route (410); delete the Gemini provider-env harness **by symbol, not by line range**: `MutableWorkerItemProviderEnv`, `WorkerItemProviderEnvSnapshot`, `withMissingGeminiItemProvider`, `setDurableObjectItemProviderEnv`, and `customAmazonGenerationTargetFor` (~4925–4980 span; A7). **`withWorkerTestModeEnabled`/`setDurableObjectTestModeEnv` (~4888–4922) MUST SURVIVE this phase** — they are still used by the live test-expire-turn suite and are deleted in P4. Also delete the `WORKER_ITEM_PROVIDER=deterministic` comment at ~2025. ADD: "START_ROOM response lands directly in proposingWidth with the deck item", "ADVANCE_ROUND picks deck index (round−1) % len", "POST /api/rooms/:id/custom-amazon-item → 404", "a planted v3 envelope purges on first touch" (cutover regression, mirroring :3356 style).
- Add unit test for `static-deck.ts` (all GAME_MODES non-empty, key shape, bounds; D4 scoping).
- Flagged-field fixtures — compile-critical set (A4): `src/lib/room/authorization.test.ts:218`, `dispatcher.test.ts:301`, `commands.test.ts:934`, `snapshot.test.ts:351` all construct configs with `{ aiGenerated: true }`; convert to flag-free configs and **re-validate any assertions pinned to the old role order** (D5 changed the calendar these fixtures encode).
- `src/lib/room/persistence.test.ts`: delete the legacy-migration describe (601–~970) + fixtures (~1139–1330); update version assertions (126–140: unsupported set, expected version 3→4); extend invalid-scrape-field case range to 271–274 then delete (A10); drop scraped fixture at 1317.
- `src/lib/room/protocol.test.ts`, `snapshot.test.ts` (103–118, 158–184, 368), `commands.test.ts` (302), `dispatcher.test.ts`: strip flagged-field cases; ADD negative: CONFIGURE_ROOM with `customAmazonQuery` → decode error; settled snapshot JSON contains no `amazon` substring.
- `src/lib/game/reducer.test.ts`: remove role-swap-on-custom cases; keep uniform `rolesForRound` coverage.
- `src/components/ItemPanel.test.tsx` / `src/components/SettlementPanel.test.tsx`: scrape cases out. (`src/app/page.test.tsx` has NO scrape cases — instead remove the `submitCustomAmazonItem` mock key at :45, A11.)
- `README.md`: delete §"Amazon Organic Scraper & Custom Query Toggle" inline (full pass in P5).

**E2E (same PR as the deletions — B1/B7)**
- Rewrite `e2e/game-flow.spec.ts` (124, 281, 338) and `e2e/visual-audit.spec.ts` (40–66, 172–194) to a surviving mode (Chaos Quant); flows proceed Start → width proposal directly. Keep the mode-agnostic T-4 silent-drop and F-04 offline-advance specs intact; add one happy-path spec per surviving mode.
- **Delete `e2e/turn-clock.spec.ts` (211 lines) in THIS phase under the CUT default (F1):** it cannot survive past P1+2 — it drives rooms through the custom-amazon flow (`custom-amazon-query-form` visible at :40 and :114) and its F-06 forced-side test pins settlement math to true_value 99.99 supplied by `WORKER_ITEM_PROVIDER=deterministic` via that query (:186–192), all of which this phase deletes. Keeping it until P4 would leave `npm run test:e2e` red on main between P1+2 and P4, violating the never-red rule. Delete `fastForwardTurnClock` from `e2e/helpers.ts` (:98–126) in the same commit — it has no other consumer — along with its stale gate comment at helpers.ts:95 (which mis-cites `WORKER_ITEM_PROVIDER`; under a KEEP decision the helper survives but that comment still dies/rewords here because the var itself is gone after this phase).
- `playwright.config.ts` var cleanup as above. *(KEEP-path alternative: instead of deleting, rewrite `turn-clock.spec.ts` in P4 against static-mode flows + the surviving test route.)*

**Verification**
- Full local gates: `lint && typecheck && test && worker-test && build:cloudflare && test:e2e`.
- Manual `preview:cloudflare`: fresh room plays end-to-end in every surviving mode; custom-amazon POST → 404; planted v3 envelope purges cleanly; second-browser-tab session degrades gracefully per the new invalidated-room handler.
- Standing-grep output appended to PR: `Gemini|GEMINI`, `amazon|Amazon|scraped|customAmazonQuery|aiGenerated`, `WORKER_ITEM_PROVIDER`.

---

### Phase 3 — Synchronous settlement; delete provider-failure machinery (F-02/F-07)

Goal: `EXECUTE_TRADE` commits choosingSide → settlement in ONE transaction using the recomputed deck item; `settling`/`generatingItem` never persist or broadcast; all retry/failure machinery deleted. **Persistence v5 cutover** (D2): `VERSION = 5`, `MIN_SUPPORTED = 5` — required because this phase removes persistable phases/keys while v4 rooms could still exist between deploys.

**round_id continuation rule (B3 — load-bearing)**

`SETTLEMENT_RECEIVED` hard-rejects a mismatched `round_id` (reducer.ts:551–553), and post-P3 that rejection path would persist a `settling` state that the decoder no longer accepts ⇒ next touch purges the room. Therefore:

- The settled item handed to the composed `SETTLEMENT_RECEIVED` **MUST reuse `room.game.item.round_id` attached by the composed `ITEM_RECEIVED`** earlier in the same round (in-memory; same transaction).
- Deck fields (`item_title/category/context_clue/true_value`) come from `itemForRound(mode, roundNumber)` (D3-decided modulo seam).
- Compose as: `settled = { ...itemForRound(...), round_id: room.game.item.round_id }`; assert `settled.round_id === room.game.item.round_id` immediately before dispatch (belt-and-suspenders; the spread makes it structurally true).

**Modify — worker `src/worker/index.ts`**
- Composition in `applyDecodedRoomCommand`'s success path (single transaction): EXECUTE_TRADE → dispatch `EXECUTE_TRADE` (transient settling) → dispatch `SETTLEMENT_RECEIVED` with the rule above → persist once, broadcast once. START_ROOM/ADVANCE_ROUND likewise compose `START_GAME/NEXT_ROUND → ITEM_RECEIVED`.
- Delete: alarm()'s pending-effect arm (1017–1048 partial), `runDuePendingRoomEffect` (1154), `runDueSettleEffect` (1179–1271), `forceFailStuckSettlement` (1279–1338), `writePendingRoomEffect`/`pendingRoomEffectForStorage`/`loadPendingRoomEffect`/`freshSettlePendingEffect`/`nextSettlePendingEffectAttempt` (3110–3178), `pendingEffectForCommittedRoom` (3188–3210), `PENDING_ROOM_EFFECT_STORAGE_KEY` + `PENDING_SETTLE_EFFECT_*` consts (121–124), `SETTLEMENT_RETRY_EXHAUSTED_MESSAGE` (125), `PendingRoomEffect` type (276–281); `scheduleNextAlarm` (2207) and `persistRoomEnvelope` (2174) lose the pendingEffect parameter; `purgeExpiredRoomState` (3242) drops the marker-key delete. F-06's alarm-path settle becomes inline within `runDueTurnExpiry`'s own transaction using the same composition helper (dies entirely under P4-CUT).
- Private item storage: delete the storage put in `receiveGeneratedProviderItem` (1794–1797), then `receiveStoredSettlement` (1877–1966), `recordRoomItemFailure` (1825–1875), `shouldDeletePrivateGeneratedItemsAfterCommand` (3252) + call site (1452–1454), `deletePrivateGeneratedItems` remainder (3220), `PRIVATE_ITEM_UNAVAILABLE_MESSAGE` (151).
- RETRY_ITEM_GENERATION: remove from `applyAutomaticRoomEffects` (1538–1544) and `shouldGenerateItemAfterCommand`; dispatcher arm goes with the protocol removal.
- `settlingRoundFailure` consumers: reset/kick guards (233, 275) + mapping `round_settling` in `statusForDomainError` deleted with the guard (threat model gone — outcome resolves atomically with EXECUTE_TRADE).
- **Deploy-readiness script (A1):** rewrite `scripts/assert-durable-room-ready.mjs` needles 27–41 — replace `privateGeneratedItemStorageKey` / `loadPrivateGeneratedItemEnvelope` / `createSettledGeneratedItem`(file) checks with deck-settlement needles, e.g. `{path:"src/worker/index.ts", needle:"itemForRound"}` ("Settlement derives the true value from the static deck") and `{path:"src/worker/static-deck.ts", needle:"itemForRound"}`; keep `LEGACY_NEXT_GAME_API_PATHS`/`applyAutomaticRoomEffects` checks. **Update `src/worker/cloudflare-config.test.ts:44–48` in the same commit** (it pins the script text and runs under plain `npm test`). This supersedes v1's incorrect R10 claim that the script is unaffected.

**Delete files**
- `src/worker/private-generated-items.ts` (196 lines).

**Modify — protocol/domain**
- `protocol.ts`: remove `RETRY_ITEM_GENERATION` from `ClientRoomCommand`; remove `ITEM_FAILED`/`SETTLEMENT_FAILED` from `SystemRoomEvent` (keep `ITEM_RECEIVED`/`SETTLEMENT_RECEIVED`/`TURN_EXPIRED` internal events).
- `dispatcher.ts`: drop `retryRoomItemGeneration`, `failRoomItem`, `failRoomSettlement` arms/imports.
- `commands.ts`: delete `retryRoomItemGeneration` (349–384), `failRoomItem` (312–326), `failRoomSettlement` (501–523), `settlingRoundFailure` (802–812) + its 756–801 comment block; `receiveRoomItem`/`receiveRoomSettlement` stay (composed calls).
- `game/types.ts`: delete actions `RETRY_ITEM_GENERATION`/`ITEM_FAILED`/`SETTLEMENT_FAILED`; delete `SETTLEMENT_FAILURE_EPISODE_CAP` (84); drop `lockedPendingTrade`/`settlementFailureCount` from `ChoosingSideGameState` and `settlementFailureCount` from `SettlingGameState`; delete `ErrorGameState` + `"error"` from `GamePhase` (safe: only ITEM_FAILED / terminal SETTLEMENT_FAILED produced it — review F7 concurs).
- `game/reducer.ts`: delete RETRY (358–384), ITEM_FAILED (339–356), SETTLEMENT_FAILED (582–671).
- `persistence.ts` (**v5**): delete `generatingItem`/`settling`/`error` decode cases (316–318, 363–379, 402–407); `choosingSide` allowlist loses `lockedPendingTrade`/`settlementFailureCount` (335–362 shrink); bump version/floor per D2.
- `statusForDomainError` (worker): map `persistence_version_unsupported` → **410** alongside `persistence_expired` (B5; current 500 mapping at index.ts:3462–3468 mis-signals a planned invalidation as a server bug).
- `room-client.ts`: delete `ITEM_GENERATION_REQUEST_TIMEOUT_MS` (62) and the stale Gemini/Amazon rationale block (25–62, A12); every command uses the default 30 s bound.
- `page.tsx`: drop `ITEM_GENERATION_COMMAND_TYPES` special-casing (149–158, 563–567); delete settling panel (1652–1705), retry buttons (1587–1626, 1826–1835), `canRetryItemGeneration` (1973–1985), `onRetryItemGeneration` threading, RETRY member of `ClientCommandInput` (135), unreachable generic generatingItem panel remainder (1443–1457).

**Tests**
- `src/lib/room-client.test.ts` (A3): delete the `ITEM_GENERATION_REQUEST_TIMEOUT_MS` budget assertions (228–251) and RETRY serialization tests (253–289); import at :6 goes.
- `index.worker-test.ts` — **import/helper purge first (A13):** the file imports `privateGeneratedItemStorageKey`/`privateGeneratedItemStoragePrefix` at 13–15, used well beyond the F-02/F-07 corpus (:935, :1110, :1211, :1555, :1584, private-item suites 3194–3511). Then apply the **delete-and-regrow strategy** (B7): the file is ONE giant describe ("Cloudflare worker scaffold", line 229, ~72 `it`s, shared harness like `readPendingRoomEffect`/`TestPendingRoomEffect`/`runDueSettleEffectDirect` used across ≥8 suites), so per-feature deletion works at corpus level, not describe level — delete feature corpora (1291, 1478, 1611, 1689, 1859, 2430, 2518, 2613, 2740, 2872, 3021, 3102-area, 5236–5411 harness), regrow thin suites ("EXECUTE_TRADE HTTP response IS the settlement phase", "no `settling` envelope ever persists" negative assertion per B3, "alarm fires only for TTL/liveness while idle"), prune orphaned helpers running `npm run worker-test` after each area.
  **KEEP-surface regression net (declared, B7):** authorization.test.ts + worker auth/kick/stale-token/replay-dedupe suites; persistence `isSettlementConsistent` zero-sum recompute; reducer PnL cases in settlement.test.ts; TTL/liveness/purge worker suites; rewritten e2e. These must stay green at every commit.
- `protocol.test.ts` RETRY decode cases (135–145), `commands.test.ts` retry/fail suites, `reducer.test.ts` SETTLEMENT_FAILED/bounce suites, `snapshot.test.ts`, `persistence.test.ts` (allowlists + version expectations → 5), `cloudflare-config.test.ts` (see script bullet above), `page.test.tsx` retry affordance corpus (describes at 380–437 incl. F-02 stuck-settling retry; `canAbortRound` describes ~417/634; `settlement-permanently-failed` at 787/851; `lockedPendingTrade`/`turnDeadlineMs` fixture 886–896; retry panel 903).
- `scripts/assert-durable-room-ready.mjs`: covered via cloudflare-config.test.ts above.

**Verification**
- Full local gates incl. e2e; record before/after worker-test counts in the PR body.
- Manual: full match; kill `wrangler dev` mid-EXECUTE_TRADE repeatedly (transactional all-or-nothing); storage inspector shows only `room:persistence:*` + `room:command-dedupe:*`; planted v4 envelope purges (v5 cutover regression test).
- Standing-grep: `PendingRoomEffect|PENDING_SETTLE|forceFailStuck|SETTLEMENT_FAILURE_EPISODE|RETRY_ITEM_GENERATION|lockedPendingTrade|settlementFailureCount|privateGeneratedItem|pregenerated-items|ITEM_GENERATION_REQUEST_TIMEOUT`.

---

### Phase 4 — Shot-clock decision execution (D1; default = CUT). **Persistence v6 cutover under CUT** (D2)

**CUT path (default)**

- `game/types.ts`: delete `*_TURN_DURATION_MS` ×4 (16–19), `MIN_TURN_DURATION_MS` (34–39), `PROPOSING_WIDTH_FORFEIT_PENALTY` (64); `GameAction` loses `TURN_EXPIRED` + all `turnDeadlineMs` action fields; delete `RoundForfeit`, `RoundSettlement.forcedByTimeout` (163–171), `PendingTradeDecision` (196–208 — `settling.pendingTrade` collapses to plain `TradeSide`); phase states lose `turnDeadlineMs`; `GamePhase` loses `"roundForfeited"` (`"settling"` STAYS as transient-only — EXECUTE_TRADE composes through it in-memory; only its persistence allowlist entry dies).
- `game/reducer.ts`: delete `TURN_EXPIRED` (673–753) and dead machinery: `settlingStateFromChoosingSideTimeout` (207–238), `turnOwnerForPhase`/`assertNeverPhase` (166–185), `UNSET_TURN_DEADLINE_MS` (59) + `turnDeadlineMs` params on wrappers `receiveItem/submitInitialWidth/tightenWidth/tradeOnWidth/submitMarketQuote` (828–888) (B6 sweep).
- `game/settlement.ts`: delete `resolvePendingTradeSide` + `applyForfeitToScores`; `calculateSettlement` loses `forcedByTimeout`.
- `room/commands.ts`: delete `expireRoomTurn` (535–552), `isTurnClockedPhase` (664–671); `advanceRoomRound` guard loses `"roundForfeited"` (573).
- `room/protocol.ts`: `SystemRoomEvent` loses `TURN_EXPIRED`; format labels for dead phases in `format.ts`.
- `room/persistence.ts` (**v6**): `roundForfeited` decode case deleted (390–395); `isRoundForfeit` validator deleted (743–752); `isPendingTradeDecision` deleted (835–845); `isRoundSettlement`/`isSettlementConsistent` lose `forcedByTimeout` checks (~740s); version/floor → 6.
- `room/snapshot.ts`: `toPublicSettlement` drops `forcedByTimeout` (385).
- Worker: delete `testExpireTurnSoon` (679–802) incl. `WORKER_TEST_MODE` read (716), route branches (400–402, 2456–2464), `ROOM_TEST_EXPIRE_TURN_ENDPOINT`/`PUBLIC_TEST_EXPIRE_TURN_ROUTE` (94, 97), `E2E_FAST_FORWARD_TURN_OFFSET_MS` (113), `turnDeadlineForRoom` (3098–3108), `runDueTurnExpiry` (1051–1152) wholesale; alarm() = TTL + liveness; `worker-configuration.d.ts` regen (WORKER_TEST_MODE gone).
- UI: delete `RoundForfeitPanel.tsx` + test (104+111), `TurnCountdown.tsx` + test (51+52) [D1a-FORCED]; **barrel edits in same commits: `components/index.ts` lines 16 and 19** (A2); page.tsx roundForfeited branch (1737–1761), TurnCountdown render sites (1469, 1500, 1530, 1584, 1633), roundForfeited announce case (294–303).
- Client lib: `room-socket-supervisor.ts` `DEAD_SOCKET_RECOVERY_BUDGET_MS` stays (socket concern). **`src/lib/turn-clock-recovery-budget.test.ts`: DELETE outright** (A5 disposition — it imports `MIN_TURN_DURATION_MS` from game/types; deleting the const deletes the file's reason to exist).
- Config: playwright.config.ts drops `--var WORKER_TEST_MODE:1`; vitest.worker.config.ts likewise; delete the test-mode env helpers from index.worker-test.ts **by symbol**: `withWorkerTestModeEnabled` and `setDurableObjectTestModeEnv` (survived P1+2 deliberately; no remaining callers once the test-expire-turn suites die).
- E2E: none — `e2e/turn-clock.spec.ts` + `fastForwardTurnClock` were already deleted in P1+2 under the CUT default (F1); nothing clock-related remains in `e2e/`.

**P4 test-update corpus (explicit, per A5/B6):**
- `reducer.test.ts`: ~40+ combined TURN_EXPIRED/roundForfeited/turnDeadlineMs/RoundForfeit references — delete clock/forfeit suites, keep trade-flow coverage.
- `commands.test.ts`: expireRoomTurn/TURN_EXPIRED cases (8) + advanceRoomRound roundForfeited-guard cases — delete/guard-narrow.
- `persistence.test.ts`: the file's actual P4 workload is its 17 `turnDeadlineMs` references plus 14 `forcedByTimeout` references — strip deadline-stamping fixtures/cases and forced-timeout settlement cases accordingly. It has **zero** forfeit references (no roundForfeited round-trip cases, no forfeit-validator tests exist here — v2's bullet to that effect was phantom and is removed); the `roundForfeited` decode case and `isRoundForfeit` validator die in persistence.ts itself per the bullets above. F-07 episode-counter describe (367) already died in P3.
- `snapshot.test.ts`: 7 references (deadline/forfeit fixtures) — strip.
- `page.test.tsx`: turnDeadlineMs fixture at ~891 — strip field.
- `SettlementPanel.tsx` forcedByTimeout note (71–79) + `SettlementPanel.test.tsx` forced cases (159–182) — delete branch/tests.
- `settlement.test.ts`: `forcedByTimeout` cases (16–63) + `resolvePendingTradeSide` describe (66+) — delete; keep pure PnL cases.
- ADD: v6 cutover regression (planted v5 envelope purges); "alarm stays TTL+liveness-only while idle".

**KEEP path (if D1 flips):** retain deadlines/route/panels/e2e clock spec; only F-06's marker coupling is already gone (P3 made the timeout settle inline inside `runDueTurnExpiry`'s single transaction via the composition helper); update the clock e2e's forced-side expectations to inline reality; alarm = TTL + liveness + turn clock. ~100-line delta on P3 instead of ~900-line deletion. Under KEEP, no v6 bump (shapes unchanged).

**Verification:** full local gates incl. e2e; manual full match; (CUT) `rg WORKER_TEST_MODE|turnDeadlineMs|TURN_EXPIRED` returns empty; (KEEP) force expiry via test route and watch worst-side settle broadcast.

---

### Phase 5 — Docs/specs/tests coherence + final gates

**Docs**
- `specs/cloudflare-worker.md`: routes table (minus custom-amazon-item, test-expire-turn per D1), "Private Item Storage And Effects" (75–87) → "No private item storage — deck-derived settlement", Environment (118–123) minus removed vars, Gates unchanged.
- `specs/room-protocol.md`: client commands (drop RETRY), system events (drop ITEM_FAILED/SETTLEMENT_FAILED/TURN_EXPIRED per D1), snapshot fields. **Fix the pre-existing factual error at :67 while rewriting** (A12): it claims the test-expire-turn route is gated on `WORKER_ITEM_PROVIDER`; the actual gate is `WORKER_TEST_MODE` (index.ts:716) — carry forward the correct fact or (under CUT) delete the section.
- `specs/room-domain.md`: drop F-05/F-06/F-07 sections per D1; Persistence section documents v6 + no-migration policy + TTL + per-phase cutover history.
- DELETE `specs/item-generation.md` (28 lines), `specs/item-generation-api.md` (35 lines).
- `README.md`: rewrite Setup/Gemini/Amazon sections → "Static market deck" (mention D3 variant + D5 calendar change); Quality Gates unchanged; release notes: per-phase room invalidation, `wrangler secret delete GEMINI_API_KEY`, asymmetric-revert caveat (below).
- `src/worker/entrypoint-exports.worker-test.ts` comments (~20–24): reword the two "see PR_BODY.md" references now that the file is gone (A9) — point at the git commit that introduced the guard.
- `src/lib/room-client.ts`: confirm the 25–62 rationale block removal landed in P3 (A12).

**Repo**
- `.gitignore` persephone-line decision from P0. CI workflow unchanged structurally (comment fix landed in P1+2).

**Final verification matrix**
1. `npm ci && npm run lint && npm run typecheck && npm test && npm run worker-test && npm run build:cloudflare && npm run test:e2e`.
2. `preview:cloudflare` manual matrix: full 3-round match both browsers; invite-link mobile join; background-tab reconnect; guest eviction badge; every surviving mode deals valid items; storage inspector shows only room+persistence/dedupe keys; idle room arms no alarm beyond TTL.
3. Deploy to staging; rerun matrix; confirm secret deletion healthy.

Standing rule per PR: append `rg` output proving zero residual references. **Gate scope (F5):** the grep runs over `src/ e2e/ config/ scripts/ specs/ README.md` only; `.agents/`, `.claude/`, and `.codex/` are declared exceptions — they reference removed vars (e.g. WORKER_ITEM_PROVIDER) in prose but are untouchable per Non-goals, so an unscoped gate would false-fail. Symbols by phase — P1+2: `Gemini|GEMINI`, `amazon|Amazon|scraped|customAmazonQuery|aiGenerated`, `WORKER_ITEM_PROVIDER`; P3: `PendingRoomEffect|PENDING_SETTLE|forceFailStuck|SETTLEMENT_FAILURE_EPISODE|RETRY_ITEM_GENERATION|lockedPendingTrade|privateGeneratedItem|pregenerated-items`; P4: `WORKER_TEST_MODE|turnDeadlineMs|TURN_EXPIRED|RoundForfeit|TurnCountdown|forcedByTimeout|resolvePendingTradeSide`.

---

## 5. Verification strategy summary

| Phase | Gates | Extra |
|---|---|---|
| 0 | lint/typecheck | `git status` clean except intended |
| 1+2 | ALL gates + e2e (same PR) | v3-envelope purge regression; invalidated-room client handler check; cross-mode manual play |
| 3 | ALL gates + e2e | crash-mid-command transactional checks; storage-key audit; v4→v5 purge regression; worker-test count delta recorded; assert-script contract test green |
| 4 | ALL gates + e2e | (CUT) symbol greps empty; v5→v6 purge regression; (KEEP) expiry e2e |
| 5 | ALL gates + staging deploy | full manual matrix |

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Hard persistence cutovers invalidate live rooms** at each shape-changing deploy (≤2 h TTL window); players recreate | Certain (by design) | Low | Per-phase bumps keep each deploy internally consistent (B2); self-heal purge paths tested; release-note per phase |
| R2 | **Stale clients**: old tabs POST removed flags → 400s; invalidated rooms previously froze at "Live" | Medium | Low | Strict decode accepted by default; B5 client handler clears session + shows "room ended" CTA; reload fixes rendering |
| R3 | **Deck repetition**: same items recur across matches; answers memorizable across sessions | Certain (accepted) | Low | Owner-accepted MVP tradeoff (D3 decided): modulo pick + `totalRounds ≤ maxRoundsForDeck()` validation prevents in-match repeats entirely; remedy for cross-match boredom is adding deck rows, not crypto |
| R4 | **Proposer-calendar flip (D5)** changes every default match's role rhythm | Certain | Cosmetic/behavioral | Documented in README/release notes |
| R5 | **E2E coverage loss** during rewrites | Medium | Medium | Rewrites land in the SAME PR as deletions (B1/B7); T-4 reconnect + F-04 offline-advance specs preserved verbatim; per-mode happy paths added |
| R6 | **Worker-test surgery** on the single 6,213-line describe with shared helpers breaks unrelated suites | High if rushed | Medium | Delete-and-regrow strategy + explicit KEEP-surface regression net + `npm run worker-test` after each corpus (B7) |
| R7 | **Sync-settlement round_id drift** silently purges rooms (rejection path persists un-decodable settling) | Low (rule enforced) | High | B3 continuation rule + identity assert + dedicated negative test ("no settling envelope persists") |
| R8 | **Secret-scanning removal** weakens future leak protection | Low | Low | README note on reinstating; mechanism is small (~95 lines in git history) |
| R9 | **Asymmetric revert (B8)**: reverting P2 after P3/P4 restores a floor-4 decoder that rejects newer envelopes — post-revert rooms die on first touch | Low | Medium (emergency-acceptable) | Declared policy: revert only in emergencies, pair with immediate re-forward-fix; documented in P5 release notes |
| R10 | **Deploy-readiness script drift** breaks `deploy:cloudflare` (script text is contract-tested) | Certain if unaddressed | Deploy blocker | A1: needles rewritten + cloudflare-config.test.ts updated in the same P3 commit |
| R11 | **Mid-train version-skew bricking** if a phase skips its bump | Low (mandated) | High | D2 mandates v4/v5/v6 tied to shape changes; each phase's regression test plants the previous version's envelope |

## 7. Estimated scope reduction (corrected, v2)

**Files deleted outright (tracked):**

| Group | Files | Lines |
|---|---|---|
| `src/api/item-generation/*` | 9 | ~1,113 |
| `src/worker/item-provider.ts` + test | 2 | ~281 |
| `src/worker/private-generated-items.ts` | 1 | ~196 |
| Components: CustomAmazonQueryForm (.tsx+.module.css), RoundForfeitPanel (.tsx+test), TurnCountdown (.tsx+test) [D1a] | 6 | ~410 |
| `config/gemini-markets.json` + static-markets Amazon section (250–332) | 1 (+section) | ~93 |
| `e2e/turn-clock.spec.ts` (D1=CUT; deleted in P1+2 per F1) | 1 | ~211 |
| `specs/item-generation.md` + `specs/item-generation-api.md` | 2 | 63 |
| `src/lib/turn-clock-recovery-budget.test.ts` (D1=CUT) | 1 | ~60 |
| `PR_BODY.md` | 1 | 440 (34,551 bytes) |
| Subtotal | ~24 | **~2,867** |

**Heavy in-place shrinkage:**

| File | Now | Est. after | Δ |
|---|---|---|---|
| `src/worker/index.ts` | 3,520 | ~1,850 (D1=CUT) | −1,650 |
| `src/worker/index.worker-test.ts` | 6,213 | ~3,200 | −3,000 |
| `src/lib/room/persistence.ts` | 918 | ~480 | −440 |
| `src/lib/game/reducer.ts` | 896 | ~580 | −320 |
| `src/lib/game/types.ts` | 395 | ~200 | −195 |
| `src/lib/room/{protocol,commands,snapshot}.ts` | 903/812/~400 | ~690/600/330 | −495 |
| `src/app/page.tsx` | 2,244 | ~1,800 | −440 |
| Other tests (reducer/commands/protocol/snapshot/persistence/page/component/client suites) | — | — | ≈ −1,000 |
| `scripts/build-cloudflare.mjs` | 129 | ~35 | −95 |
| **Net tracked-code delta (D1=CUT)** | | | **≈ −8,300 to −10,000 lines** |

Reference counts used above (rg-verified): `customAmazonQuery` — reducer.ts 16, room/protocol.ts 6, room/persistence.ts 6, room/snapshot.ts 2 (30 across the four core domain files; plus commands.ts 4, worker/index.ts, types/UI sites listed per phase). Dependencies: `@google/genai` removed. Env surface: `GEMINI_API_KEY`, `WORKER_ITEM_PROVIDER` (P1+2), `WORKER_TEST_MODE` (P4). Storage keys retired: `room:pregenerated-items:v1` (P1+2), `room:pending-effect:v1` + `room:private-generated-item:v1:*` (P3). Envelope versions 3→4→5→(6).

## 8. Resolved review items (traceability)

- A1 → P3 deploy-script bullets. A2 → P1+2/P4 barrel bullets. A3/A11 → P3 room-client/page.test bullets. A4 → P1+2 fixture list. A5/B6 → P4 test corpus + dead-code sweep + recovery-budget disposition. A6 → P1+2 ItemPanel/CSS bullets. A7 → P1+2 plumbing list + standing-grep symbol. A8/A9/A10/A12/A13 → respective phase bullets. A14/A15 → §7 corrected. B1 → phase merge (§3). B2 → D2. B3 → P3 continuation rule + negative test. B4 → D3(b) recommendation. B5 → P1+2 client handler + P3 410 mapping. B7 → P3 test strategy + regression net. B8 → §3 train policy + R9. B9 → D1a/D3 marked FORCED, D4 optional; checklist #6 resolved (room/import-boundaries.test.ts is room-domain purity only — untouched); #2/#8 resolved per F7/threat-model analysis; v1's #10 (prompts/) withdrawn — prompts/ has zero F-machinery references. Verified-fine notes folded in: wrangler.toml carries no [vars]; `LEGACY_NEXT_GAME_API_PATHS` already lists `/api/generate-custom-amazon-item`; non-Amazon deck items carry only the four core keys.

Owner decisions locked 2026-08-24 (v4): D1 = CUT shot clocks (P4 executes the CUT path incl. the v6 cutover); D3 = plain-modulo pick + `totalRounds ≤ maxRoundsForDeck()` validation cap; D4 = delete the Amazon deck section. Nothing remains open.

## 9. Revision history

- **v1 (2026-08-23):** initial draft from repo investigation.
- **v2 (2026-08-23):** incorporated two adversarial reviews — a completeness audit (A1–A15: deploy-readiness script contract, component barrel, missed test files/fixtures, missing P4 test corpus, ItemPanel scrape display, incomplete WORKER_ITEM_PROVIDER removal, CSS/spec/comment corrections, inaccurate reference counts and size estimates) and an architecture audit (B1–B9: mandatory P1+P2 merge to keep main green, per-phase persistence version bumps, round_id continuation rule for synchronous settlement, HMAC deck-offset recommendation, invalidated-room client handling + 410 mapping, shot-cut ripple/dead-code sweep, delete-and-regrow test strategy with declared regression net, stacked-PR train with asymmetric-revert caveat, decisions triage). Every A/B finding is addressed in-place; traceability table in §8.
- **v4 (2026-08-24):** owner locked all three open decisions — D1 = CUT shot clocks (P4 executes the CUT path incl. the v6 bump); D3 = plain-modulo pick with `totalRounds ≤ maxRoundsForDeck()` validation cap (HMAC variant withdrawn as over-engineered; `static-deck.ts` signature simplified to `itemForRound(mode, roundNumber)`); D4 = delete the Amazon deck section. Plan is execution-ready; no open items remain.
- **v3 (2026-08-23):** incorporated final-gate review findings — one major (F1: `e2e/turn-clock.spec.ts` deletion moved from P4 into Phase 1+2 under the CUT default; it drives the deleted custom-amazon flow and pins deterministic-provider math, so it would have left `npm run test:e2e` red on main between P1+2 and P4; `fastForwardTurnClock` + its stale helpers.ts:95 gate comment die in the same commit) and four minors (F2: worker-test helper deletions switched from line ranges to symbol names, preserving `withWorkerTestModeEnabled`/`setDurableObjectTestModeEnv` until P4; F3: phantom protocol.test.ts TURN_EXPIRED bullet removed — zero matches in that file and no `turn_expired` wire string exists; F4: phantom persistence.test.ts forfeit bullets removed — its real P4 workload is the 17 turnDeadlineMs + 14 forcedByTimeout refs, now stated explicitly — plus "five core keys"→"four" and commands.ts count 3→4 corrections; F5: standing grep gate scoped to `src/ e2e/ config/ scripts/ specs/ README.md` with `.agents/.claude/.codex` declared exceptions). Review loop converged: **0 blockers, 0 majors outstanding.**
