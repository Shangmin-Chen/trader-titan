import {
  advanceRoomRound,
  configureRoom,
  executeTrade,
  failRoomItem,
  failRoomSettlement,
  joinRoom,
  kickGuest,
  receiveRoomItem,
  receiveRoomSettlement,
  resetRoomToLobby,
  startRoom,
  submitInitialWidth,
  submitMarketQuote,
  tightenWidth,
  tradeOnWidth,
} from "./commands";
import type { ClientRoomCommand, SystemRoomEvent } from "./protocol";
import type { TokenVerifier } from "./tokens";
import type { RoomCommandResult, RoomState } from "./types";

/**
 * Durable Objects can share one command execution path after protocol decoding,
 * keeping authorization and game mutations inside the room domain layer.
 */
export function dispatchRoomCommand(
  room: RoomState,
  command: ClientRoomCommand,
  verifyToken: TokenVerifier,
): RoomCommandResult {
  switch (command.type) {
    case "JOIN_ROOM":
      return joinRoom(room, {
        guestTokenHash: command.guestTokenHash,
        guestName: command.guestName,
        nowMs: command.nowMs,
      });
    case "CONFIGURE_ROOM":
      return configureRoom(room, {
        credential: command.credential,
        config: command.config,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "START_ROOM":
      return startRoom(room, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "RESET_TO_LOBBY":
      return resetRoomToLobby(room, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "KICK_GUEST":
      return kickGuest(room, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "ADVANCE_ROUND":
      return advanceRoomRound(room, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "SUBMIT_INITIAL_WIDTH":
      return submitInitialWidth(room, command.width, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "TIGHTEN_WIDTH":
      return tightenWidth(room, command.width, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "TRADE_ON_WIDTH":
      return tradeOnWidth(room, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "SUBMIT_MARKET_QUOTE":
      return submitMarketQuote(room, command.quote, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    case "EXECUTE_TRADE":
      return executeTrade(room, command.side, {
        credential: command.credential,
        verifyToken,
        nowMs: command.nowMs,
      });
    default:
      return assertNever(command);
  }
}

/**
 * System event dispatch remains server-authoritative by passing only the event
 * fields accepted by room commands, never caller-supplied settlement data.
 */
export function dispatchSystemRoomEvent(
  room: RoomState,
  event: SystemRoomEvent,
): RoomCommandResult {
  switch (event.type) {
    case "ITEM_RECEIVED":
      return receiveRoomItem(room, event.item, event.nowMs);
    case "ITEM_FAILED":
      return failRoomItem(room, event.error, event.nowMs);
    case "SETTLEMENT_RECEIVED":
      return receiveRoomSettlement(room, event.item, event.nowMs);
    case "SETTLEMENT_FAILED":
      return failRoomSettlement(room, event.error, event.nowMs);
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled room protocol variant: ${String(value)}`);
}
