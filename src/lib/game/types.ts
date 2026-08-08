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
export const PROPOSING_WIDTH_FORFEIT_PENALTY = 100;

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
};

/**
 * Records a round that ended because a player's shot clock expired rather
 * than through a trade. `phase` is the actionable phase the clock ran out
 * in (never "settling" or any non-clocked phase - see TURN_EXPIRED in the
 * reducer). Zero-sum like RoundSettlement: forfeitedBy loses `penalty`,
 * awardedTo gains it.
 */
export type RoundForfeit = {
  roundNumber: number;
  itemTitle: string;
  phase: GamePhase;
  forfeitedBy: PlayerId;
  awardedTo: PlayerId;
  penalty: number;
};

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
};

export type SettlingGameState = GameStateBase & {
  phase: "settling";
  item: GeneratedItem;
  spreadWidth: number;
  quote: Quote;
  pendingSide: TradeSide;
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
