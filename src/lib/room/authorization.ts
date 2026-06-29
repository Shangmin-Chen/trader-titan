import type { PlayerId } from "../game/types";
import {
  parseCapabilityToken,
  tokenBelongsToRoom,
  type PresentedCapabilityToken,
  type TokenVerifier,
} from "./tokens";
import {
  HOST_PLAYER_ID,
  GUEST_PLAYER_ID,
  roomDomainError,
  type AuthorizedActor,
  type RoomDomainError,
  type RoomState,
} from "./types";

export type AuthorizationRequirement =
  | Readonly<{ type: "access" }>
  | Readonly<{ type: "hostControl" }>
  | Readonly<{ type: "activePlayer"; playerId: PlayerId }>;

export type AuthorizationSuccess = Readonly<{
  ok: true;
  actor: AuthorizedActor;
}>;

export type AuthorizationFailure = Readonly<{
  ok: false;
  error: RoomDomainError;
}>;

export type AuthorizationResult = AuthorizationSuccess | AuthorizationFailure;

/**
 * Room persistence stores token hashes, so authorization must receive the
 * runtime verifier as an injected deterministic dependency.
 */
export function authorizeRoomAction(
  room: RoomState,
  credential: PresentedCapabilityToken | null | undefined,
  requirement: AuthorizationRequirement,
  verifyToken: TokenVerifier,
): AuthorizationResult {
  const access = authorizeRoomAccess(room, credential, verifyToken);

  if (!access.ok) {
    return access;
  }

  if (requirement.type === "access") {
    return access;
  }

  if (requirement.type === "hostControl" && access.actor.role !== "host") {
    return failure("host_control_denied", "Only the host can perform this room command.");
  }

  if (
    requirement.type === "activePlayer" &&
    access.actor.playerId !== requirement.playerId
  ) {
    return failure(
      "wrong_active_role",
      `This command requires Player ${requirement.playerId}.`,
    );
  }

  return access;
}

export function authorizeRoomAccess(
  room: RoomState,
  credential: PresentedCapabilityToken | null | undefined,
  verifyToken: TokenVerifier,
): AuthorizationResult {
  const parsed = parseCapabilityToken(credential);

  if (!parsed.ok) {
    if (parsed.error.code === "token_missing") {
      return failure("missing_token", parsed.error.message);
    }

    if (parsed.error.code === "spectator_access_denied") {
      return failure("spectator_access_denied", parsed.error.message);
    }

    return failure("invalid_token", parsed.error.message);
  }

  const token = parsed.token;

  if (!tokenBelongsToRoom(token, room.id)) {
    return failure("wrong_room", "Capability token belongs to a different room.");
  }

  if (token.role === "host") {
    if (!verifyToken(token, room.host.tokenHash)) {
      return failure("token_mismatch", "Host capability token was rejected.");
    }

    return {
      ok: true,
      actor: {
        role: "host",
        playerId: HOST_PLAYER_ID,
        displayName: room.host.displayName,
      },
    };
  }

  if (room.guest === null) {
    return failure("stale_guest", "Guest capability is stale or the guest slot is empty.");
  }

  if (!verifyToken(token, room.guest.tokenHash)) {
    return failure("stale_guest", "Guest capability is stale or has been replaced.");
  }

  return {
    ok: true,
    actor: {
      role: "guest",
      playerId: GUEST_PLAYER_ID,
      displayName: room.guest.displayName,
    },
  };
}

function failure(
  code: RoomDomainError["code"],
  message: string,
): AuthorizationFailure {
  return {
    ok: false,
    error: roomDomainError(code, message),
  };
}
