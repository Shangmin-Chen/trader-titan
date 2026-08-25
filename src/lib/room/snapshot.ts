import { toPublicItem } from "../game/reducer";
import type {
  ChoosingSideGameState,
  ConfiguringMarketGameState,
  GameOverState,
  GameState,
  GeneratingItemGameState,
  NegotiatingWidthGameState,
  Player,
  PlayerId,
  RoundForfeit,
  RoundForfeitedGameState,
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
  RoomPresence,
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
  Readonly<{
    true_value: number;
  }>;
export type PublicSettlementGameState = Omit<SettlementGameState, "item"> &
  Readonly<{ item: PublicSettledGeneratedItem }>;
export type PublicRoundForfeitedGameState = RoundForfeitedGameState;
export type PublicGameOverState = GameOverState;

export type PublicRoomGameState =
  | PublicSetupGameState
  | PublicGeneratingItemGameState
  | PublicProposingWidthGameState
  | PublicNegotiatingWidthGameState
  | PublicConfiguringMarketGameState
  | PublicChoosingSideGameState
  | PublicSettlingGameState
  | PublicSettlementGameState
  | PublicRoundForfeitedGameState
  | PublicGameOverState;

export type PublicRoomPresence = Readonly<{
  players: Readonly<Record<PlayerId, boolean>>;
}>;

export type PublicRoomSnapshot = Readonly<{
  id: RoomId;
  lifecycle: RoomLifecycle;
  config: RoomGameConfig;
  seats: Readonly<{
    host: PublicRoomSeat;
    guest: PublicRoomSeat;
  }>;
  presence: PublicRoomPresence;
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
export function toPublicRoomSnapshot(
  room: RoomState,
  presence: RoomPresence,
): PublicRoomSnapshot {
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
    presence: toPublicRoomPresence(room, presence),
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
    case "proposingWidth":
      return {
        ...publicGameBase(game),
        phase: "proposingWidth",
        item: toPublicItem(game.item),
        turnDeadlineMs: game.turnDeadlineMs,
      };
    case "negotiatingWidth":
      return {
        ...publicGameBase(game),
        phase: "negotiatingWidth",
        item: toPublicItem(game.item),
        spreadWidth: game.spreadWidth,
        turnDeadlineMs: game.turnDeadlineMs,
      };
    case "configuringMarket":
      return {
        ...publicGameBase(game),
        phase: "configuringMarket",
        item: toPublicItem(game.item),
        spreadWidth: game.spreadWidth,
        turnDeadlineMs: game.turnDeadlineMs,
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
        turnDeadlineMs: game.turnDeadlineMs,
      };
    case "roundForfeited":
      return {
        ...publicGameBase(game),
        phase: "roundForfeited",
        forfeit: toPublicForfeit(game.forfeit),
      };
    case "settling":
      // Transient-only since Phase 3: the Worker composes straight through
      // settling into settlement in one storage transaction, so this branch
      // only exists to keep the phase mapping exhaustive - no broadcast
      // should ever carry it.
      return {
        ...publicGameBase(game),
        phase: "settling",
        item: toPublicItem(game.item),
        spreadWidth: game.spreadWidth,
        quote: {
          bid: game.quote.bid,
          ask: game.quote.ask,
        },
        pendingTrade: game.pendingTrade,
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

function toPublicRoomPresence(
  room: RoomState,
  presence: RoomPresence,
): PublicRoomPresence {
  return {
    players: {
      A: presence.players.A === true,
      B: room.guest !== null && presence.players.B === true,
    },
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
    forcedByTimeout: settlement.forcedByTimeout,
  };
}

function toPublicForfeit(forfeit: RoundForfeit): RoundForfeit {
  return {
    roundNumber: forfeit.roundNumber,
    itemTitle: forfeit.itemTitle,
    phase: forfeit.phase,
    forfeitedBy: forfeit.forfeitedBy,
    awardedTo: forfeit.awardedTo,
    penalty: forfeit.penalty,
  };
}
