import type { GameMode, GameState, PlayerId } from "../game/types";
import type { RoomId } from "./ids";
import type { CapabilityRole, TokenHash } from "./tokens";

export const HOST_PLAYER_ID = "A" satisfies PlayerId;
export const GUEST_PLAYER_ID = "B" satisfies PlayerId;
export const DEFAULT_HOST_NAME = "Host";
export const DEFAULT_GUEST_NAME = "Guest";
export const DEFAULT_ROOM_MODE: GameMode = "Chaos Quant";
export const DEFAULT_ROOM_TOTAL_ROUNDS = 3;
export const PLAYER_DISPLAY_NAME_MAX_LENGTH = 80;

export type UnixTimeMs = number;
export type RoomLifecycle = "lobby" | "active" | "finished";
export type RoomPresence = Readonly<{
  players: Readonly<Record<PlayerId, boolean>>;
}>;

export type RoomGameConfig = Readonly<{
  mode: GameMode;
  totalRounds: number;
  customAmazonQuery?: boolean;
  aiGenerated?: boolean;
}>;

export type HostSeat = Readonly<{
  role: "host";
  playerId: typeof HOST_PLAYER_ID;
  displayName: string;
  tokenHash: TokenHash;
  joinedAtMs: UnixTimeMs;
}>;

export type GuestSeat = Readonly<{
  role: "guest";
  playerId: typeof GUEST_PLAYER_ID;
  displayName: string;
  tokenHash: TokenHash;
  joinedAtMs: UnixTimeMs;
}>;

export type RoomSeat = HostSeat | GuestSeat;

export type RoomState = Readonly<{
  id: RoomId;
  lifecycle: RoomLifecycle;
  config: RoomGameConfig;
  host: HostSeat;
  guest: GuestSeat | null;
  game: GameState;
  createdAtMs: UnixTimeMs;
  updatedAtMs: UnixTimeMs;
  revision: number;
}>;

export type AuthorizedActor = Readonly<{
  role: CapabilityRole;
  playerId: PlayerId;
  displayName: string;
}>;

export type RoomDomainErrorCode =
  | "missing_token"
  | "invalid_token"
  | "wrong_room"
  | "spectator_access_denied"
  | "token_mismatch"
  | "stale_guest"
  | "host_control_denied"
  | "wrong_active_role"
  | "room_not_in_lobby"
  | "room_not_active"
  | "room_not_finished"
  | "guest_slot_full"
  | "guest_slot_empty"
  | "guest_required"
  | "player_offline"
  | "invalid_config"
  | "invalid_game_phase"
  | "persistence_invalid"
  | "persistence_version_unsupported"
  | "persistence_expired";

export type RoomDomainError = Readonly<{
  code: RoomDomainErrorCode;
  message: string;
}>;

export type RoomCommandSuccess = Readonly<{
  ok: true;
  room: RoomState;
}>;

export type RoomCommandFailure = Readonly<{
  ok: false;
  room: RoomState;
  error: RoomDomainError;
}>;

export type RoomCommandResult = RoomCommandSuccess | RoomCommandFailure;

export function roomDomainError(
  code: RoomDomainErrorCode,
  message: string,
): RoomDomainError {
  return { code, message };
}
