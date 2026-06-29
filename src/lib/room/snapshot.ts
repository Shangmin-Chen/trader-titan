import { toPublicItem } from "../game/reducer";
import type {
  ChoosingSideGameState,
  ConfiguringMarketGameState,
  ErrorGameState,
  GameOverState,
  GameState,
  GeneratingItemGameState,
  NegotiatingWidthGameState,
  Player,
  RoundLogEntry,
  RoundSettlement,
  Scores,
  ProposingWidthGameState,
  PublicGeneratedItem,
  SettlementGameState,
  SettledGeneratedItem,
  SettlingGameState,
  SetupGameState,
} from "../game/types";
import type { RoomId } from "./ids";
import type {
  RoomGameConfig,
  RoomLifecycle,
  RoomState,
  UnixTimeMs,
} from "./types";

export type PublicRoomSeat =
  | Readonly<{
      occupied: true;
      role: "host";
      playerId: "A";
      displayName: string;
    }>
  | Readonly<{
      occupied: true;
      role: "guest";
      playerId: "B";
      displayName: string;
    }>
  | Readonly<{
      occupied: false;
      role: "guest";
      playerId: "B";
      displayName: null;
    }>;

export type PublicSetupGameState = SetupGameState;
export type PublicGeneratingItemGameState = GeneratingItemGameState;
export type PublicProposingWidthGameState = Omit<ProposingWidthGameState, "item"> &
  Readonly<{ item: PublicGeneratedItem }>;
export type PublicNegotiatingWidthGameState = Omit<NegotiatingWidthGameState, "item"> &
  Readonly<{ item: PublicGeneratedItem }>;
export type PublicConfiguringMarketGameState = Omit<ConfiguringMarketGameState, "item"> &
  Readonly<{ item: PublicGeneratedItem }>;
export type PublicChoosingSideGameState = Omit<ChoosingSideGameState, "item"> &
  Readonly<{ item: PublicGeneratedItem }>;
export type PublicSettlingGameState = Omit<SettlingGameState, "item"> &
  Readonly<{ item: PublicGeneratedItem }>;
export type PublicSettledGeneratedItem = PublicGeneratedItem &
  Readonly<{ true_value: number }>;
export type PublicSettlementGameState = Omit<SettlementGameState, "item"> &
  Readonly<{ item: PublicSettledGeneratedItem }>;
export type PublicGameOverState = GameOverState;
export type PublicErrorGameState = ErrorGameState;

export type PublicRoomGameState =
  | PublicSetupGameState
  | PublicGeneratingItemGameState
  | PublicProposingWidthGameState
  | PublicNegotiatingWidthGameState
  | PublicConfiguringMarketGameState
  | PublicChoosingSideGameState
  | PublicSettlingGameState
  | PublicSettlementGameState
  | PublicGameOverState
  | PublicErrorGameState;

export type PublicRoomSnapshot = Readonly<{
  id: RoomId;
  lifecycle: RoomLifecycle;
  config: RoomGameConfig;
  seats: Readonly<{
    host: PublicRoomSeat;
    guest: PublicRoomSeat;
  }>;
  game: PublicRoomGameState;
  createdAtMs: UnixTimeMs;
  updatedAtMs: UnixTimeMs;
  revision: number;
}>;

export type PublicRoomInvitePreview = Readonly<{
  id: RoomId;
  lifecycle: RoomLifecycle;
  host: Readonly<{
    displayName: string;
  }>;
  guest: Readonly<{
    occupied: boolean;
  }>;
  joinable: boolean;
  createdAtMs: UnixTimeMs;
  updatedAtMs: UnixTimeMs;
  revision: number;
}>;

/**
 * Snapshots are the only room shape intended for clients, so every credential
 * and persistence-only field is omitted here rather than relying on callers.
 */
export function toPublicRoomSnapshot(room: RoomState): PublicRoomSnapshot {
  return {
    id: room.id,
    lifecycle: room.lifecycle,
    config: room.config,
    seats: {
      host: {
        occupied: true,
        role: "host",
        playerId: "A",
        displayName: room.host.displayName,
      },
      guest:
        room.guest === null
          ? {
              occupied: false,
              role: "guest",
              playerId: "B",
              displayName: null,
            }
          : {
              occupied: true,
              role: "guest",
              playerId: "B",
              displayName: room.guest.displayName,
            },
    },
    game: toPublicGameState(room.game),
    createdAtMs: room.createdAtMs,
    updatedAtMs: room.updatedAtMs,
    revision: room.revision,
  };
}

export function toPublicRoomInvitePreview(room: RoomState): PublicRoomInvitePreview {
  return {
    id: room.id,
    lifecycle: room.lifecycle,
    host: {
      displayName: room.host.displayName,
    },
    guest: {
      occupied: room.guest !== null,
    },
    joinable: room.lifecycle === "lobby" && room.guest === null,
    createdAtMs: room.createdAtMs,
    updatedAtMs: room.updatedAtMs,
    revision: room.revision,
  };
}

export function toPublicGameState(game: GameState): PublicRoomGameState {
  switch (game.phase) {
    case "setup":
      return {
        ...publicGameBase(game),
        phase: "setup",
      };
    case "generatingItem":
      return {
        ...publicGameBase(game),
        phase: "generatingItem",
      };
    case "settlement":
      return {
        ...publicGameBase(game),
        phase: "settlement",
        item: toPublicSettledItem(game.item),
        spreadWidth: game.spreadWidth,
        quote: {
          bid: game.quote.bid,
          ask: game.quote.ask,
        },
        settlement: toPublicSettlement(game.settlement),
      };
    case "gameOver":
      return {
        ...publicGameBase(game),
        phase: "gameOver",
        winner: game.winner,
      };
    case "error":
      return {
        ...publicGameBase(game),
        phase: "error",
        error: game.error,
        previousPhase: game.previousPhase,
      };
    case "proposingWidth":
      return {
        ...publicGameBase(game),
        phase: "proposingWidth",
        item: toPublicItem(game.item),
      };
    case "negotiatingWidth":
      return {
        ...publicGameBase(game),
        phase: "negotiatingWidth",
        item: toPublicItem(game.item),
        spreadWidth: game.spreadWidth,
      };
    case "configuringMarket":
      return {
        ...publicGameBase(game),
        phase: "configuringMarket",
        item: toPublicItem(game.item),
        spreadWidth: game.spreadWidth,
      };
    case "choosingSide":
      return {
        ...publicGameBase(game),
        phase: "choosingSide",
        item: toPublicItem(game.item),
        spreadWidth: game.spreadWidth,
        quote: {
          bid: game.quote.bid,
          ask: game.quote.ask,
        },
      };
    case "settling":
      return {
        ...publicGameBase(game),
        phase: "settling",
        item: toPublicItem(game.item),
        spreadWidth: game.spreadWidth,
        quote: {
          bid: game.quote.bid,
          ask: game.quote.ask,
        },
        pendingSide: game.pendingSide,
      };
    default:
      return assertNever(game);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled game phase: ${JSON.stringify(value)}`);
}

function publicGameBase(game: GameState): Omit<SetupGameState, "phase"> {
  return {
    mode: game.mode,
    ...(game.customAmazonQuery === undefined
      ? {}
      : { customAmazonQuery: game.customAmazonQuery }),
    players: {
      A: publicPlayer(game.players.A),
      B: publicPlayer(game.players.B),
    },
    scores: publicScores(game.scores),
    roles: {
      marketMaker: game.roles.marketMaker,
      trader: game.roles.trader,
    },
    roundNumber: game.roundNumber,
    totalRounds: game.totalRounds,
    log: game.log.map(publicLogEntry),
    ...(game.lastError === undefined ? {} : { lastError: game.lastError }),
  };
}

function publicPlayer(player: Player): Player {
  return {
    id: player.id,
    name: player.name,
  };
}

function publicScores(scores: Scores): Scores {
  return {
    A: scores.A,
    B: scores.B,
  };
}

function publicLogEntry(entry: RoundLogEntry): RoundLogEntry {
  return {
    id: entry.id,
    roundNumber: entry.roundNumber,
    phase: entry.phase,
    message: entry.message,
  };
}

function toPublicSettledItem(
  item: SettledGeneratedItem,
): PublicSettledGeneratedItem {
  return {
    ...toPublicItem(item),
    true_value: item.true_value,
  };
}

function toPublicSettlement(settlement: RoundSettlement): RoundSettlement {
  return {
    roundNumber: settlement.roundNumber,
    itemTitle: settlement.itemTitle,
    side: settlement.side,
    transactionPrice: settlement.transactionPrice,
    trueValue: settlement.trueValue,
    trader: settlement.trader,
    marketMaker: settlement.marketMaker,
    traderPnL: settlement.traderPnL,
    marketMakerPnL: settlement.marketMakerPnL,
  };
}
