export const GAME_MODES = [
  "Fermi Math & Geometry",
  "Static Landmarks & History",
  "Cosmic Scale",
  "Chaos Quant",
  "Amazon",
] as const;

export const MAX_ROUNDS = 99;
export const MAX_PLAYABLE_ABSOLUTE_VALUE = 1_000_000_000_000;

// F-05 turn shot-clock durations. Per-phase because a binary choice
// (choosingSide) needs less thinking time than making a market
// (configuringMarket), which needs less than the opening proposal
// (proposingWidth, where the player is also still reading the item).
export const PROPOSING_WIDTH_TURN_DURATION_MS = 60_000;
export const NEGOTIATING_WIDTH_TURN_DURATION_MS = 45_000;
export const CONFIGURING_MARKET_TURN_DURATION_MS = 60_000;
export const CHOOSING_SIDE_TURN_DURATION_MS = 30_000;

// The shortest of the four durations above — currently choosingSide, whose
// F-06 timeout settlement makes it the phase where a player who cannot
// detect and recover from their own dead socket in time pays the highest
// (unbounded, not flat-capped) price. See
// `DEAD_SOCKET_RECOVERY_BUDGET_MS` in room-socket-supervisor.ts, and the
// inequality test in turn-clock-recovery-budget.test.ts that pins this
// constant against it: a disconnected player's worst-case self-heal time
// (detect the dead socket, back off, reopen, get resynced) must fit inside
// this with real margin, or a routine Wi-Fi blip can silently cost a
// player the round no matter which side of the trade they were on.
// Computed with Math.min (not hand-copied) so adding a new turn phase with
// a shorter clock automatically flows into that test instead of being
// silently missed.
export const MIN_TURN_DURATION_MS = Math.min(
  PROPOSING_WIDTH_TURN_DURATION_MS,
  NEGOTIATING_WIDTH_TURN_DURATION_MS,
  CONFIGURING_MARKET_TURN_DURATION_MS,
  CHOOSING_SIDE_TURN_DURATION_MS,
);

// proposingWidth has no spread width yet when the clock runs out (the market
// maker never proposed one), so a forfeit there needs its own fixed stake
// rather than "the width in play". Settlement PnL scales with the item's
// true value, which this repo's own fixtures and static market config put
// anywhere from double digits (Amazon, Chaos Quant) to the tens of
// thousands (Cosmic Scale, Fermi Math) - and the default game mode (Chaos
// Quant) has a true_value median in the same 2-3 digit neighborhood as the
// spread widths already used throughout this codebase's own tests (100,
// 200, 300, 500). 100 keeps an early-round forfeit a real stake in that
// mode instead of a token amount that would make stalling free.
//
// This flat-penalty forfeit still applies to proposingWidth, negotiatingWidth,
// and configuringMarket. It deliberately does NOT apply to choosingSide any
// more (F-06): by choosingSide the trader has already seen the market
// maker's two-sided quote, and settlement PnL (trueValue - transactionPrice)
// is unbounded and unrelated to the spread width. A flat, width-sized
// penalty there let a trader who read the quote as badly mispriced against
// them deliberately stall out the clock to cap their loss at the spread
// width instead of taking a much larger settlement loss - the shot clock
// handed them a free downside-capped option. See TURN_EXPIRED in the
// reducer and resolvePendingTradeSide in settlement.ts for the fix: a
// choosingSide timeout now settles as if the trader took whichever side is
// worse for them, so stalling can never beat acting.
export const PROPOSING_WIDTH_FORFEIT_PENALTY = 100;

// F-07: bounds cross-episode SETTLEMENT_FAILED bounces (choosingSide(locked)
// -> settling -> SETTLEMENT_FAILED -> choosingSide(locked)), i.e. how many
// separate `settling` episodes a single round may burn through before this
// is treated as a persistent, non-transient failure rather than a one-off
// hiccup. This is a different axis from PENDING_SETTLE_EFFECT_MAX_ATTEMPTS
// (src/worker/index.ts), which bounds alarm-driven retries *within* one
// settling episode with its own exponential backoff (up to 5 attempts, up
// to 5 minutes apart) before that episode itself bounces back to
// choosingSide - this constant instead bounds how many times that bounce
// itself may happen for the same round. Each episode is already fairly
// resilient to a transient blip (network hiccup, a momentarily evicted
// isolate) via its own attempt budget, so recovering from a genuinely
// transient cause rarely needs more than a bounce or two; 3 total episodes
// allows one retry beyond that margin while still keeping the worst case
// (a structurally broken round - e.g. corrupted private item storage) to a
// handful of bounded episodes instead of an unbounded cycle with no
// terminal state. See settlementFailureCount on ChoosingSideGameState and
// SettlingGameState, and the SETTLEMENT_FAILED case in reducer.ts.
export const SETTLEMENT_FAILURE_EPISODE_CAP = 3;

export type GameMode = (typeof GAME_MODES)[number];

export type UnixTimeMs = number;

export type PlayerId = "A" | "B";

export type Player = {
  id: PlayerId;
  name: string;
};

export type Scores = Record<PlayerId, number>;

export type Roles = {
  marketMaker: PlayerId;
  trader: PlayerId;
};

export type Quote = {
  bid: number;
  ask: number;
};

export type ScrapedAmazonItem = {
  title: string;
  price: number;
};

export type QuantItemFields = {
  item_title: string;
  category: string;
  context_clue: string;
};

export type ProviderGeneratedItem = QuantItemFields & {
  true_value: number;
  scraped_items?: ScrapedAmazonItem[];
  amazon_url?: string;
};

export type GeneratedItem = QuantItemFields & {
  round_id: string;
};

export type PublicGeneratedItem = GeneratedItem;

export type SettledGeneratedItem = GeneratedItem & {
  true_value: number;
  scraped_items?: ScrapedAmazonItem[];
  amazon_url?: string;
};

export type TradeSide = "BUY" | "SELL";

export type GamePhase =
  | "setup"
  | "generatingItem"
  | "proposingWidth"
  | "negotiatingWidth"
  | "configuringMarket"
  | "choosingSide"
  | "settling"
  | "settlement"
  | "roundForfeited"
  | "gameOver"
  | "error";

export type RoundSettlement = {
  roundNumber: number;
  itemTitle: string;
  side: TradeSide;
  transactionPrice: number;
  trueValue: number;
  trader: PlayerId;
  marketMaker: PlayerId;
  traderPnL: number;
  marketMakerPnL: number;
  // F-06: true when this settlement was not a trade the trader chose, but a
  // side forced by their choosingSide clock expiring (see
  // resolvePendingTradeSide in settlement.ts). `side` above always records
  // the side actually settled against either way, so the log and settlement
  // UI stay honest about the transaction itself; this flag is what lets
  // them also be honest about *why* - the trader did not pick `side`, the
  // clock did, picking whichever of BUY/SELL was worse for the trader.
  forcedByTimeout: boolean;
};

/**
 * Records a round that ended because a player's shot clock expired rather
 * than through a trade. `phase` is the actionable phase the clock ran out
 * in - `proposingWidth`, `negotiatingWidth`, or `configuringMarket` (never
 * `choosingSide`, `settling`, or any other non-clocked phase). choosingSide's
 * clock expiring is handled differently: see F-06 in TURN_EXPIRED in the
 * reducer - by choosingSide the trader has already seen a quote, so a flat
 * forfeit penalty would let them cap a bad settlement loss at the spread
 * width instead of taking it. That case routes through `settling` and
 * RoundSettlement (with `forcedByTimeout: true`) instead of RoundForfeit.
 * Zero-sum like RoundSettlement: forfeitedBy loses `penalty`, awardedTo
 * gains it.
 */
export type RoundForfeit = {
  roundNumber: number;
  itemTitle: string;
  phase: GamePhase;
  forfeitedBy: PlayerId;
  awardedTo: PlayerId;
  penalty: number;
};

/**
 * What `settling` is waiting to resolve into an actual TradeSide once the
 * private true_value is known server-side (see receiveRoomSettlement in
 * src/lib/room/commands.ts, the one place that has both this and true_value
 * at the same time). "chosen" is a trader's own EXECUTE_TRADE. F-06's
 * "timeoutForcedWorstSide" is a choosingSide clock expiry: the reducer
 * cannot pick a side for it at TURN_EXPIRED time (true_value is private and
 * never reaches the client-visible GameState), so it defers the decision by
 * carrying this sentinel into settling instead of a resolved TradeSide - see
 * resolvePendingTradeSide in settlement.ts for where it is finally resolved.
 */
export type PendingTradeDecision =
  | { kind: "chosen"; side: TradeSide }
  | { kind: "timeoutForcedWorstSide" };

export type RoundLogEntry = {
  id: number;
  roundNumber: number;
  phase: GamePhase;
  message: string;
};

type GameStateBase = {
  mode: GameMode;
  customAmazonQuery?: boolean;
  aiGenerated?: boolean;
  players: Record<PlayerId, Player>;
  scores: Scores;
  roles: Roles;
  roundNumber: number;
  totalRounds: number;
  log: RoundLogEntry[];
  lastError?: string;
};

export type SetupGameState = GameStateBase & {
  phase: "setup";
};

export type GeneratingItemGameState = GameStateBase & {
  phase: "generatingItem";
};

export type ProposingWidthGameState = GameStateBase & {
  phase: "proposingWidth";
  item: GeneratedItem;
  turnDeadlineMs: UnixTimeMs;
};

export type NegotiatingWidthGameState = GameStateBase & {
  phase: "negotiatingWidth";
  item: GeneratedItem;
  spreadWidth: number;
  turnDeadlineMs: UnixTimeMs;
};

export type ConfiguringMarketGameState = GameStateBase & {
  phase: "configuringMarket";
  item: GeneratedItem;
  spreadWidth: number;
  turnDeadlineMs: UnixTimeMs;
};

export type ChoosingSideGameState = GameStateBase & {
  phase: "choosingSide";
  item: GeneratedItem;
  spreadWidth: number;
  quote: Quote;
  turnDeadlineMs: UnixTimeMs;
  /**
   * Set only when this choosingSide state was re-entered via SETTLEMENT_FAILED
   * bouncing back out of `settling` (private item missing/corrupt, or F-02's
   * forceFailStuckSettlement exhaustion fallback) - never by a normal
   * SUBMIT_MARKET_QUOTE transition into a fresh choice. Carries forward
   * whichever PendingTradeDecision was already in flight when settlement
   * failed - a trader's own EXECUTE_TRADE choice, or an F-06
   * timeoutForcedWorstSide - so it isn't silently discarded.
   *
   * When present, the decision is locked: EXECUTE_TRADE's requested side is
   * ignored and settling is re-entered with this same decision instead (see
   * the EXECUTE_TRADE and TURN_EXPIRED cases in reducer.ts). Without this,
   * a trader who deliberately stalled choosingSide's clock to force a
   * worst-side settlement (F-06) could get a second, unlocked roll of the
   * dice for free any time settlement happened to fail - reopening exactly
   * the exploit F-06 closed. The clock still runs and can still expire
   * normally; while locked it measures time until the decision is retried
   * automatically, not a live choice, and the UI must not present Buy/Sell
   * as though clicking either one matters (see RoomGameView in
   * src/app/page.tsx).
   */
  lockedPendingTrade?: PendingTradeDecision;
  /**
   * How many prior `settling` episodes have already failed for this round.
   * Always present exactly when `lockedPendingTrade` is (both set together
   * by SETTLEMENT_FAILED, both absent on a plain SUBMIT_MARKET_QUOTE
   * choosingSide) - see SETTLEMENT_FAILURE_EPISODE_CAP. Carried forward
   * unchanged by EXECUTE_TRADE/TURN_EXPIRED re-entering `settling` (see
   * SettlingGameState.settlementFailureCount); SETTLEMENT_FAILED increments
   * it and, once it reaches the cap, routes to the terminal `error` phase
   * instead of bouncing back here again.
   */
  settlementFailureCount?: number;
};

export type SettlingGameState = GameStateBase & {
  phase: "settling";
  item: GeneratedItem;
  spreadWidth: number;
  quote: Quote;
  pendingTrade: PendingTradeDecision;
  /**
   * Inherited from the choosingSide this episode entered from (0 for a
   * fresh, never-yet-failed round - see ChoosingSideGameState's own doc
   * comment on this field). Untouched by this episode's own outcome until
   * SETTLEMENT_FAILED reads it to decide whether to bounce back to
   * choosingSide again or give up - see SETTLEMENT_FAILURE_EPISODE_CAP.
   */
  settlementFailureCount: number;
};

export type SettlementGameState = GameStateBase & {
  phase: "settlement";
  item: SettledGeneratedItem;
  spreadWidth: number;
  quote: Quote;
  settlement: RoundSettlement;
};

export type RoundForfeitedGameState = GameStateBase & {
  phase: "roundForfeited";
  forfeit: RoundForfeit;
};

export type GameOverState = GameStateBase & {
  phase: "gameOver";
  winner: PlayerId | "Tie";
};

export type ErrorGameState = GameStateBase & {
  phase: "error";
  error: string;
  previousPhase: GamePhase;
};

export type GameState =
  | SetupGameState
  | GeneratingItemGameState
  | ProposingWidthGameState
  | NegotiatingWidthGameState
  | ConfiguringMarketGameState
  | ChoosingSideGameState
  | SettlingGameState
  | SettlementGameState
  | RoundForfeitedGameState
  | GameOverState
  | ErrorGameState;

export type StartGamePayload = {
  playerAName: string;
  playerBName: string;
  mode: GameMode;
  totalRounds: number;
  customAmazonQuery?: boolean;
  aiGenerated?: boolean;
};

export type GameAction =
  | { type: "START_GAME"; payload: StartGamePayload }
  | { type: "ITEM_RECEIVED"; item: GeneratedItem; turnDeadlineMs: UnixTimeMs }
  | { type: "ITEM_FAILED"; error: string }
  | { type: "RETRY_ITEM_GENERATION" }
  | { type: "SUBMIT_INITIAL_WIDTH"; width: number; turnDeadlineMs: UnixTimeMs }
  | { type: "TIGHTEN_WIDTH"; width: number; turnDeadlineMs: UnixTimeMs }
  | { type: "TRADE_ON_WIDTH"; turnDeadlineMs: UnixTimeMs }
  | { type: "SUBMIT_MARKET_QUOTE"; quote: Quote; turnDeadlineMs: UnixTimeMs }
  | { type: "MARKET_COMMIT_FAILED"; error: string }
  | { type: "EXECUTE_TRADE"; side: TradeSide }
  | {
      type: "SETTLEMENT_RECEIVED";
      item: SettledGeneratedItem;
      settlement: RoundSettlement;
    }
  | { type: "SETTLEMENT_FAILED"; error: string; turnDeadlineMs: UnixTimeMs }
  // Server-only: dispatched by the Worker alarm when a stamped turnDeadlineMs
  // elapses. Never decoded from client input (see protocol.ts) - the reducer
  // trusts it exactly like SETTLEMENT_RECEIVED trusts its settlement input,
  // because both only ever originate from trusted server-side callers.
  | { type: "TURN_EXPIRED" }
  | { type: "NEXT_ROUND" }
  | { type: "RESET" };

export type InitialGameStateOptions = {
  mode?: GameMode;
  players?: Partial<Record<PlayerId, Partial<Player>>>;
  totalRounds?: number;
  startingRoles?: Roles;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };
