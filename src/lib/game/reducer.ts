import { applyForfeitToScores, applySettlementToScores } from "./settlement";
import type {
  GameAction,
  GameMode,
  GamePhase,
  GameState,
  GeneratedItem,
  InitialGameStateOptions,
  Player,
  PlayerId,
  PublicGeneratedItem,
  Roles,
  RoundForfeit,
  RoundLogEntry,
  Scores,
  SettledGeneratedItem,
  StartGamePayload,
  TradeSide,
  UnixTimeMs,
} from "./types";
import { GAME_MODES, MAX_ROUNDS, PROPOSING_WIDTH_FORFEIT_PENALTY } from "./types";
import {
  validateQuoteForWidth,
  validateSpreadWidth,
  validateStartGame,
  validateTightenedWidth,
} from "./validation";

const DEFAULT_PLAYERS: Record<PlayerId, Player> = {
  A: { id: "A", name: "Player A" },
  B: { id: "B", name: "Player B" },
};

const DEFAULT_SCORES: Scores = {
  A: 0,
  B: 0,
};

const DEFAULT_ROLES: Roles = {
  marketMaker: "A",
  trader: "B",
};

const DEFAULT_TOTAL_ROUNDS = 3;
const DEFAULT_MODE: GameMode = "Chaos Quant";

// Wrapper helpers below default `turnDeadlineMs` to this placeholder when a
// caller does not care about the shot clock (most reducer tests exercise
// game-flow logic that has nothing to do with timing). Room commands
// (src/lib/room/commands.ts) never rely on this default - they always
// compute and pass a real server-stamped deadline.
const UNSET_TURN_DEADLINE_MS = 0;

function normalizeRoles(roles: Roles): Roles {
  return roles.marketMaker === roles.trader ? DEFAULT_ROLES : roles;
}

function normalizeTotalRounds(totalRounds: number | undefined): number {
  if (!Number.isInteger(totalRounds) || totalRounds === undefined) {
    return DEFAULT_TOTAL_ROUNDS;
  }

  return Math.max(1, Math.min(totalRounds, MAX_ROUNDS));
}

function normalizeMode(mode: GameMode | undefined): GameMode {
  return mode && GAME_MODES.includes(mode) ? mode : DEFAULT_MODE;
}

function cleanName(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function buildPlayers(
  players?: InitialGameStateOptions["players"],
): Record<PlayerId, Player> {
  return {
    A: {
      ...DEFAULT_PLAYERS.A,
      ...players?.A,
      id: "A",
      name: cleanName(players?.A?.name ?? DEFAULT_PLAYERS.A.name, DEFAULT_PLAYERS.A.name),
    },
    B: {
      ...DEFAULT_PLAYERS.B,
      ...players?.B,
      id: "B",
      name: cleanName(players?.B?.name ?? DEFAULT_PLAYERS.B.name, DEFAULT_PLAYERS.B.name),
    },
  };
}

function rolesForRound(roundNumber: number): Roles {
  return roundNumber % 2 === 1
    ? DEFAULT_ROLES
    : { marketMaker: "B", trader: "A" };
}

function addLog(
  state: GameState,
  phase: GamePhase,
  message: string,
): RoundLogEntry[] {
  return [
    ...state.log,
    {
      id: state.log.length + 1,
      roundNumber: state.roundNumber,
      phase,
      message,
    },
  ];
}

function withLog<TState extends GameState>(
  state: TState,
  phase: GamePhase,
  message: string,
): TState {
  return {
    ...state,
    log: addLog(state, phase, message),
    lastError: undefined,
  };
}

function withDomainError<TState extends GameState>(
  state: TState,
  message: string,
): TState {
  return {
    ...state,
    log: addLog(state, state.phase, message),
    lastError: message,
  };
}

function swapRoles(roles: Roles): Roles {
  return {
    marketMaker: roles.trader,
    trader: roles.marketMaker,
  };
}

function roleName(state: GameState, playerId: PlayerId): string {
  return state.players[playerId].name;
}

/**
 * The player whose action the clock is currently running against, mirroring
 * which role each of these four phases waits on (see the SUBMIT_INITIAL_WIDTH
 * / TIGHTEN_WIDTH / TRADE_ON_WIDTH / SUBMIT_MARKET_QUOTE / EXECUTE_TRADE
 * cases above and expectedPlayer() in src/lib/room/commands.ts, which
 * authorizes those same commands against the same roles).
 */
function turnOwnerForPhase(
  state: Extract<
    GameState,
    { phase: "proposingWidth" | "negotiatingWidth" | "configuringMarket" | "choosingSide" }
  >,
): PlayerId {
  switch (state.phase) {
    case "proposingWidth":
    case "configuringMarket":
      return state.roles.marketMaker;
    case "negotiatingWidth":
    case "choosingSide":
      return state.roles.trader;
    default:
      return assertNeverPhase(state);
  }
}

function assertNeverPhase(value: never): never {
  throw new Error(`Unhandled turn-clocked phase: ${JSON.stringify(value)}`);
}

function winnerFromScores(scores: Scores): PlayerId | "Tie" {
  if (scores.A === scores.B) {
    return "Tie";
  }

  return scores.A > scores.B ? "A" : "B";
}

function makePlayersFromStart(payload: StartGamePayload): Record<PlayerId, Player> {
  return {
    A: {
      id: "A",
      name: cleanName(payload.playerAName, DEFAULT_PLAYERS.A.name),
    },
    B: {
      id: "B",
      name: cleanName(payload.playerBName, DEFAULT_PLAYERS.B.name),
    },
  };
}

export function toPublicItem(item: GeneratedItem): PublicGeneratedItem {
  return {
    round_id: item.round_id,
    item_title: item.item_title,
    category: item.category,
    context_clue: item.context_clue,
  };
}

export function createInitialGameState(
  options: InitialGameStateOptions = {},
): GameState {
  return {
    phase: "setup",
    mode: normalizeMode(options.mode),
    players: buildPlayers(options.players),
    scores: { ...DEFAULT_SCORES },
    roles: normalizeRoles(options.startingRoles ?? DEFAULT_ROLES),
    roundNumber: 0,
    totalRounds: normalizeTotalRounds(options.totalRounds),
    log: [],
  };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "START_GAME": {
      if (state.phase !== "setup") {
        return state;
      }

      const validation = validateStartGame(action.payload);
      if (!validation.ok) {
        return withDomainError(state, validation.error);
      }

      const nextState: GameState = {
        ...state,
        phase: "generatingItem",
        mode: action.payload.mode,
        customAmazonQuery: action.payload.customAmazonQuery === true,
        aiGenerated: action.payload.aiGenerated,
        players: makePlayersFromStart(action.payload),
        scores: { ...DEFAULT_SCORES },
        roles: action.payload.customAmazonQuery === true ? swapRoles(DEFAULT_ROLES) : DEFAULT_ROLES,
        roundNumber: 1,
        totalRounds: action.payload.totalRounds,
        log: [],
        lastError: undefined,
      };

      return withLog(
        nextState,
        "generatingItem",
        `Game started. ${roleName(nextState, nextState.roles.marketMaker)} proposes the first spread width.`,
      );
    }

    case "ITEM_RECEIVED": {
      if (state.phase !== "generatingItem") {
        return state;
      }

      const nextState: GameState = {
        ...state,
        phase: "proposingWidth",
        item: action.item,
        turnDeadlineMs: action.turnDeadlineMs,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "proposingWidth",
        `${roleName(state, state.roles.marketMaker)} is proposing the opening spread width for "${action.item.item_title}".`,
      );
    }

    case "ITEM_FAILED": {
      if (state.phase !== "generatingItem") {
        return state;
      }

      const nextState: GameState = {
        ...state,
        phase: "error",
        error: action.error,
        previousPhase: state.phase,
        lastError: action.error,
      };

      return {
        ...nextState,
        log: addLog(nextState, "error", `Item generation failed: ${action.error}`),
      };
    }

    case "RETRY_ITEM_GENERATION": {
      if (state.phase !== "error" || state.previousPhase !== "generatingItem") {
        return state;
      }

      const nextState: GameState = {
        phase: "generatingItem",
        mode: state.mode,
        customAmazonQuery: state.customAmazonQuery,
        ...(state.aiGenerated === undefined
          ? {}
          : { aiGenerated: state.aiGenerated }),
        players: state.players,
        scores: state.scores,
        roles: state.roles,
        roundNumber: state.roundNumber,
        totalRounds: state.totalRounds,
        log: state.log,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "generatingItem",
        `Retrying item generation for round ${state.roundNumber}.`,
      );
    }

    case "SUBMIT_INITIAL_WIDTH": {
      if (state.phase !== "proposingWidth") {
        return state;
      }

      const validation = validateSpreadWidth(action.width);
      if (!validation.ok) {
        return withDomainError(state, validation.error);
      }

      const nextState: GameState = {
        ...state,
        phase: "negotiatingWidth",
        spreadWidth: action.width,
        turnDeadlineMs: action.turnDeadlineMs,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "negotiatingWidth",
        `${roleName(state, state.roles.marketMaker)} proposed a ${action.width} wide spread.`,
      );
    }

    case "TIGHTEN_WIDTH": {
      if (state.phase !== "negotiatingWidth") {
        return state;
      }

      const validation = validateTightenedWidth(state.spreadWidth, action.width);
      if (!validation.ok) {
        return withDomainError(state, validation.error);
      }

      const previousTrader = state.roles.trader;
      const nextRoles = swapRoles(state.roles);
      const nextState: GameState = {
        ...state,
        phase: "negotiatingWidth",
        roles: nextRoles,
        spreadWidth: action.width,
        turnDeadlineMs: action.turnDeadlineMs,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "negotiatingWidth",
        `${roleName(state, previousTrader)} tightened the spread width to ${action.width}.`,
      );
    }

    case "TRADE_ON_WIDTH": {
      if (state.phase !== "negotiatingWidth") {
        return state;
      }

      const nextState: GameState = {
        ...state,
        phase: "configuringMarket",
        turnDeadlineMs: action.turnDeadlineMs,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "configuringMarket",
        `${roleName(state, state.roles.trader)} chose to trade on ${state.spreadWidth} width. ${roleName(state, state.roles.marketMaker)} must set the bid/ask.`,
      );
    }

    case "SUBMIT_MARKET_QUOTE": {
      if (state.phase !== "configuringMarket") {
        return state;
      }

      const validation = validateQuoteForWidth(action.quote, state.spreadWidth);
      if (!validation.ok) {
        return withDomainError(state, validation.error);
      }

      const nextState: GameState = {
        ...state,
        phase: "choosingSide",
        quote: action.quote,
        turnDeadlineMs: action.turnDeadlineMs,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "choosingSide",
        `${roleName(state, state.roles.marketMaker)} set ${action.quote.bid} / ${action.quote.ask}.`,
      );
    }

    case "MARKET_COMMIT_FAILED": {
      if (state.phase !== "configuringMarket" && state.phase !== "choosingSide") {
        return state;
      }

      return withDomainError(state, action.error);
    }

    case "EXECUTE_TRADE": {
      if (state.phase !== "choosingSide") {
        return state;
      }

      // Deliberately not `...state`: choosingSide carries turnDeadlineMs
      // (F-05), but settling is not a turn-clocked phase and must not
      // carry a stray one - the persistence decoder's per-phase key
      // allowlist (src/lib/room/persistence.ts) rejects an unexpected
      // field, and a leftover deadline would otherwise dangle unused.
      const nextState: GameState = {
        phase: "settling",
        mode: state.mode,
        ...(state.customAmazonQuery === undefined
          ? {}
          : { customAmazonQuery: state.customAmazonQuery }),
        ...(state.aiGenerated === undefined
          ? {}
          : { aiGenerated: state.aiGenerated }),
        players: state.players,
        scores: state.scores,
        roles: state.roles,
        roundNumber: state.roundNumber,
        totalRounds: state.totalRounds,
        log: state.log,
        item: state.item,
        spreadWidth: state.spreadWidth,
        quote: state.quote,
        pendingSide: action.side,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "settling",
        `${roleName(state, state.roles.trader)} chose to ${action.side === "BUY" ? "buy" : "sell"}. Settling round.`,
      );
    }

    case "SETTLEMENT_RECEIVED": {
      if (state.phase !== "settling") {
        return state;
      }

      if (action.item.round_id !== state.item.round_id) {
        return withDomainError(state, "Settlement did not match the active round.");
      }

      const nextState: GameState = {
        phase: "settlement",
        mode: state.mode,
        customAmazonQuery: state.customAmazonQuery,
        ...(state.aiGenerated === undefined
          ? {}
          : { aiGenerated: state.aiGenerated }),
        players: state.players,
        scores: applySettlementToScores(state.scores, action.settlement),
        roles: state.roles,
        roundNumber: state.roundNumber,
        totalRounds: state.totalRounds,
        log: state.log,
        item: action.item,
        spreadWidth: state.spreadWidth,
        quote: state.quote,
        settlement: action.settlement,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "settlement",
        settlementLogMessage(nextState, action.settlement.side),
      );
    }

    case "SETTLEMENT_FAILED": {
      if (state.phase !== "settling") {
        return state;
      }

      const nextState: GameState = {
        phase: "choosingSide",
        mode: state.mode,
        ...(state.customAmazonQuery === undefined
          ? {}
          : { customAmazonQuery: state.customAmazonQuery }),
        ...(state.aiGenerated === undefined
          ? {}
          : { aiGenerated: state.aiGenerated }),
        players: state.players,
        scores: state.scores,
        roles: state.roles,
        roundNumber: state.roundNumber,
        totalRounds: state.totalRounds,
        log: state.log,
        item: state.item,
        spreadWidth: state.spreadWidth,
        quote: state.quote,
        turnDeadlineMs: action.turnDeadlineMs,
        lastError: action.error,
      };

      return {
        ...nextState,
        log: addLog(nextState, "choosingSide", `Settlement failed: ${action.error}`),
      };
    }

    case "TURN_EXPIRED": {
      if (
        state.phase !== "proposingWidth" &&
        state.phase !== "negotiatingWidth" &&
        state.phase !== "configuringMarket" &&
        state.phase !== "choosingSide"
      ) {
        return state;
      }

      const forfeitedBy = turnOwnerForPhase(state);
      const awardedTo: PlayerId = forfeitedBy === "A" ? "B" : "A";
      const penalty =
        state.phase === "proposingWidth"
          ? PROPOSING_WIDTH_FORFEIT_PENALTY
          : state.spreadWidth;

      const forfeit: RoundForfeit = {
        roundNumber: state.roundNumber,
        itemTitle: state.item.item_title,
        phase: state.phase,
        forfeitedBy,
        awardedTo,
        penalty,
      };

      const nextState: GameState = {
        phase: "roundForfeited",
        mode: state.mode,
        ...(state.customAmazonQuery === undefined
          ? {}
          : { customAmazonQuery: state.customAmazonQuery }),
        ...(state.aiGenerated === undefined
          ? {}
          : { aiGenerated: state.aiGenerated }),
        players: state.players,
        scores: applyForfeitToScores(state.scores, forfeit),
        roles: state.roles,
        roundNumber: state.roundNumber,
        totalRounds: state.totalRounds,
        log: state.log,
        forfeit,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "roundForfeited",
        `${roleName(state, forfeitedBy)} ran out of time in ${state.phase}. ${roleName(state, awardedTo)} is awarded ${penalty}.`,
      );
    }

    case "NEXT_ROUND": {
      if (state.phase !== "settlement" && state.phase !== "roundForfeited") {
        return state;
      }

      if (state.roundNumber >= state.totalRounds) {
        const nextState: GameState = {
          phase: "gameOver",
          mode: state.mode,
          players: state.players,
          scores: state.scores,
          roles: state.roles,
          roundNumber: state.roundNumber,
          totalRounds: state.totalRounds,
          log: state.log,
          winner: winnerFromScores(state.scores),
          lastError: undefined,
        };

        return withLog(nextState, "gameOver", "Game ended.");
      }

      const nextRoundNumber = state.roundNumber + 1;
      const baseRoles = rolesForRound(nextRoundNumber);
      const nextState: GameState = {
        phase: "generatingItem",
        mode: state.mode,
        customAmazonQuery: state.customAmazonQuery,
        aiGenerated: state.aiGenerated,
        players: state.players,
        scores: state.scores,
        roles: state.customAmazonQuery === true ? swapRoles(baseRoles) : baseRoles,
        roundNumber: nextRoundNumber,
        totalRounds: state.totalRounds,
        log: state.log,
        lastError: undefined,
      };

      return withLog(
        nextState,
        "generatingItem",
        `Round ${nextRoundNumber} started. ${roleName(nextState, nextState.roles.marketMaker)} proposes first.`,
      );
    }

    case "RESET":
      return createInitialGameState();

    default:
      return state;
  }
}

function settlementLogMessage(state: Extract<GameState, { phase: "settlement" }>, side: TradeSide): string {
  const verb = side === "BUY" ? "bought" : "sold";
  const traderName = roleName(state, state.settlement.trader);
  const mmName = roleName(state, state.settlement.marketMaker);

  return `${traderName} ${verb} at ${state.settlement.transactionPrice}. True value was ${state.settlement.trueValue}. ${traderName} PnL ${state.settlement.traderPnL}; ${mmName} PnL ${state.settlement.marketMakerPnL}.`;
}

export function startGame(
  state: GameState,
  payload: StartGamePayload,
): GameState {
  return gameReducer(state, { type: "START_GAME", payload });
}

export function receiveItem(
  state: GameState,
  item: GeneratedItem,
  turnDeadlineMs: UnixTimeMs = UNSET_TURN_DEADLINE_MS,
): GameState {
  return gameReducer(state, { type: "ITEM_RECEIVED", item, turnDeadlineMs });
}

export function retryItemGeneration(state: GameState): GameState {
  return gameReducer(state, { type: "RETRY_ITEM_GENERATION" });
}

export function submitInitialWidth(
  state: GameState,
  width: number,
  turnDeadlineMs: UnixTimeMs = UNSET_TURN_DEADLINE_MS,
): GameState {
  return gameReducer(state, { type: "SUBMIT_INITIAL_WIDTH", width, turnDeadlineMs });
}

export function tightenWidth(
  state: GameState,
  width: number,
  turnDeadlineMs: UnixTimeMs = UNSET_TURN_DEADLINE_MS,
): GameState {
  return gameReducer(state, { type: "TIGHTEN_WIDTH", width, turnDeadlineMs });
}

export function tradeOnWidth(
  state: GameState,
  turnDeadlineMs: UnixTimeMs = UNSET_TURN_DEADLINE_MS,
): GameState {
  return gameReducer(state, { type: "TRADE_ON_WIDTH", turnDeadlineMs });
}

export function submitMarketQuote(
  state: GameState,
  quote: Extract<GameAction, { type: "SUBMIT_MARKET_QUOTE" }>["quote"],
  turnDeadlineMs: UnixTimeMs = UNSET_TURN_DEADLINE_MS,
): GameState {
  return gameReducer(state, { type: "SUBMIT_MARKET_QUOTE", quote, turnDeadlineMs });
}

export function executeTrade(
  state: GameState,
  side: Extract<GameAction, { type: "EXECUTE_TRADE" }>["side"],
): GameState {
  return gameReducer(state, { type: "EXECUTE_TRADE", side });
}

export function receiveSettlement(
  state: GameState,
  item: SettledGeneratedItem,
  settlement: Extract<GameAction, { type: "SETTLEMENT_RECEIVED" }>["settlement"],
): GameState {
  return gameReducer(state, { type: "SETTLEMENT_RECEIVED", item, settlement });
}

export function expireTurn(state: GameState): GameState {
  return gameReducer(state, { type: "TURN_EXPIRED" });
}

export function nextRound(state: GameState): GameState {
  return gameReducer(state, { type: "NEXT_ROUND" });
}

export function resetGame(): GameState {
  return createInitialGameState();
}
