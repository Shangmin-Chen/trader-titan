export const GAME_MODES = [
  "Fermi Math & Geometry",
  "Static Landmarks & History",
  "Cosmic Scale",
  "Chaos Quant",
] as const;

export const MAX_ROUNDS = 99;
export const MAX_PLAYABLE_ABSOLUTE_VALUE = 1_000_000_000_000;

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

export type QuantItemFields = {
  item_title: string;
  category: string;
  context_clue: string;
};

export type ProviderGeneratedItem = QuantItemFields & {
  true_value: number;
};

export type GeneratedItem = QuantItemFields & {
  round_id: string;
};

export type PublicGeneratedItem = GeneratedItem;

export type SettledGeneratedItem = GeneratedItem & {
  true_value: number;
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
  | "gameOver";

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

export type RoundLogEntry = {
  id: number;
  roundNumber: number;
  phase: GamePhase;
  message: string;
};

type GameStateBase = {
  mode: GameMode;
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
};

export type NegotiatingWidthGameState = GameStateBase & {
  phase: "negotiatingWidth";
  item: GeneratedItem;
  spreadWidth: number;
};

export type ConfiguringMarketGameState = GameStateBase & {
  phase: "configuringMarket";
  item: GeneratedItem;
  spreadWidth: number;
};

export type ChoosingSideGameState = GameStateBase & {
  phase: "choosingSide";
  item: GeneratedItem;
  spreadWidth: number;
  quote: Quote;
};

export type SettlingGameState = GameStateBase & {
  // Transient-only since Phase 3's synchronous settlement: EXECUTE_TRADE
  // composes straight through this phase into "settlement" within a single
  // storage transaction, so a settling state is never persisted and never
  // broadcast. It remains a valid GamePhase because the reducer still
  // produces it as an intermediate value and the round log can reference it.
  phase: "settling";
  item: GeneratedItem;
  spreadWidth: number;
  quote: Quote;
  pendingTrade: TradeSide;
};

export type SettlementGameState = GameStateBase & {
  phase: "settlement";
  item: SettledGeneratedItem;
  spreadWidth: number;
  quote: Quote;
  settlement: RoundSettlement;
};

export type GameOverState = GameStateBase & {
  phase: "gameOver";
  winner: PlayerId | "Tie";
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
  | GameOverState;

export type StartGamePayload = {
  playerAName: string;
  playerBName: string;
  mode: GameMode;
  totalRounds: number;
};

export type GameAction =
  | { type: "START_GAME"; payload: StartGamePayload }
  | { type: "ITEM_RECEIVED"; item: GeneratedItem }
  | { type: "SUBMIT_INITIAL_WIDTH"; width: number }
  | { type: "TIGHTEN_WIDTH"; width: number }
  | { type: "TRADE_ON_WIDTH" }
  | { type: "SUBMIT_MARKET_QUOTE"; quote: Quote }
  | { type: "MARKET_COMMIT_FAILED"; error: string }
  | { type: "EXECUTE_TRADE"; side: TradeSide }
  | {
      type: "SETTLEMENT_RECEIVED";
      item: SettledGeneratedItem;
      settlement: RoundSettlement;
    }
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
