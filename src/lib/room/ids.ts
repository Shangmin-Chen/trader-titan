const ROOM_ID_MIN_LENGTH = 6;
const ROOM_ID_MAX_LENGTH = 64;
const ROOM_ID_ALLOWED_CHARACTERS = /^[A-Za-z0-9_-]+$/u;

declare const roomIdBrand: unique symbol;

export type RoomId = string & { readonly [roomIdBrand]: "RoomId" };

export type RoomIdValidationErrorCode =
  | "room_id_not_string"
  | "room_id_empty"
  | "room_id_too_short"
  | "room_id_too_long"
  | "room_id_invalid_characters";

export type RoomIdValidationError = Readonly<{
  code: RoomIdValidationErrorCode;
  message: string;
}>;

export type RoomIdValidationResult =
  | Readonly<{ ok: true; roomId: RoomId }>
  | Readonly<{ ok: false; error: RoomIdValidationError }>;

/**
 * Runtime boundaries receive room ids as plain strings, so the brand is only
 * introduced after the deterministic format checks have run.
 */
export function parseRoomId(value: unknown): RoomIdValidationResult {
  if (typeof value !== "string") {
    return failure("room_id_not_string", "Room id must be a string.");
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return failure("room_id_empty", "Room id is required.");
  }

  if (trimmed.length < ROOM_ID_MIN_LENGTH) {
    return failure("room_id_too_short", "Room id is too short.");
  }

  if (trimmed.length > ROOM_ID_MAX_LENGTH) {
    return failure("room_id_too_long", "Room id is too long.");
  }

  if (!ROOM_ID_ALLOWED_CHARACTERS.test(trimmed)) {
    return failure(
      "room_id_invalid_characters",
      "Room id may only contain letters, numbers, underscores, and hyphens.",
    );
  }

  return { ok: true, roomId: trimmed as RoomId };
}

export function roomIdsEqual(left: RoomId, right: RoomId): boolean {
  return left === right;
}

function failure(
  code: RoomIdValidationErrorCode,
  message: string,
): RoomIdValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}
