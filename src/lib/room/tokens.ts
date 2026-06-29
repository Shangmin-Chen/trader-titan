import { parseRoomId, roomIdsEqual, type RoomId } from "./ids";

const TOKEN_SECRET_MIN_LENGTH = 24;
const TOKEN_SECRET_MAX_LENGTH = 160;
const TOKEN_SECRET_ALLOWED_CHARACTERS = /^[A-Za-z0-9_-]+$/u;
const TOKEN_HASH_MIN_LENGTH = 8;
const TOKEN_HASH_MAX_LENGTH = 256;
const TOKEN_HASH_ALLOWED_CHARACTERS = /^[A-Za-z0-9._~:-]+$/u;

declare const tokenSecretBrand: unique symbol;
declare const tokenHashBrand: unique symbol;

export type CapabilityRole = "host" | "guest";
export type TokenSecret = string & { readonly [tokenSecretBrand]: "TokenSecret" };
export type TokenHash = string & { readonly [tokenHashBrand]: "TokenHash" };

export type PresentedCapabilityToken = Readonly<{
  roomId: string;
  role: string;
  secret: string;
}>;

export type RoomCapabilityToken = Readonly<{
  roomId: RoomId;
  role: CapabilityRole;
  secret: TokenSecret;
}>;

export type TokenHasher = (token: RoomCapabilityToken) => TokenHash;
export type TokenVerifier = (
  token: RoomCapabilityToken,
  expectedHash: TokenHash,
) => boolean;

export type TokenValidationErrorCode =
  | "token_missing"
  | "token_not_object"
  | "token_room_id_invalid"
  | "token_role_invalid"
  | "spectator_access_denied"
  | "token_secret_invalid"
  | "token_secret_too_short"
  | "token_secret_too_long"
  | "token_secret_invalid_characters";

export type TokenHashValidationErrorCode =
  | "token_hash_not_string"
  | "token_hash_empty"
  | "token_hash_too_short"
  | "token_hash_too_long"
  | "token_hash_invalid_characters";

export type TokenValidationError = Readonly<{
  code: TokenValidationErrorCode;
  message: string;
}>;

export type TokenHashValidationError = Readonly<{
  code: TokenHashValidationErrorCode;
  message: string;
}>;

export type TokenValidationResult =
  | Readonly<{ ok: true; token: RoomCapabilityToken }>
  | TokenErrorResult;

type TokenErrorResult = Readonly<{ ok: false; error: TokenValidationError }>;

export type TokenHashValidationResult =
  | Readonly<{ ok: true; tokenHash: TokenHash }>
  | Readonly<{ ok: false; error: TokenHashValidationError }>;

/**
 * Parses browser-stored capabilities without assuming how the runtime encodes,
 * encrypts, or transports them.
 */
export function parseCapabilityToken(value: unknown): TokenValidationResult {
  if (value === null || value === undefined) {
    return tokenFailure("token_missing", "Capability token is required.");
  }

  if (typeof value !== "object") {
    return tokenFailure("token_not_object", "Capability token must be an object.");
  }

  const candidate = value as Partial<PresentedCapabilityToken>;
  const roomId = parseRoomId(candidate.roomId);

  if (!roomId.ok) {
    return tokenFailure("token_room_id_invalid", roomId.error.message);
  }

  const role = parseCapabilityRole(candidate.role);

  if (!role.ok) {
    return role;
  }

  const secret = parseTokenSecret(candidate.secret);

  if (!secret.ok) {
    return secret;
  }

  return {
    ok: true,
    token: {
      roomId: roomId.roomId,
      role: role.role,
      secret: secret.secret,
    },
  };
}

export function parseTokenHash(value: unknown): TokenHashValidationResult {
  if (typeof value !== "string") {
    return hashFailure("token_hash_not_string", "Token hash must be a string.");
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return hashFailure("token_hash_empty", "Token hash is required.");
  }

  if (trimmed.length < TOKEN_HASH_MIN_LENGTH) {
    return hashFailure("token_hash_too_short", "Token hash is too short.");
  }

  if (trimmed.length > TOKEN_HASH_MAX_LENGTH) {
    return hashFailure("token_hash_too_long", "Token hash is too long.");
  }

  if (!TOKEN_HASH_ALLOWED_CHARACTERS.test(trimmed)) {
    return hashFailure("token_hash_invalid_characters", "Token hash has invalid characters.");
  }

  return { ok: true, tokenHash: trimmed as TokenHash };
}

export function tokenBelongsToRoom(token: RoomCapabilityToken, roomId: RoomId): boolean {
  return roomIdsEqual(token.roomId, roomId);
}

function parseCapabilityRole(
  value: unknown,
):
  | Readonly<{ ok: true; role: CapabilityRole }>
  | TokenErrorResult {
  if (value === "host" || value === "guest") {
    return { ok: true, role: value };
  }

  if (value === "spectator") {
    return tokenFailure("spectator_access_denied", "Spectator access is not supported.");
  }

  return tokenFailure("token_role_invalid", "Capability token role must be host or guest.");
}

function parseTokenSecret(
  value: unknown,
):
  | Readonly<{ ok: true; secret: TokenSecret }>
  | TokenErrorResult {
  if (typeof value !== "string") {
    return tokenFailure("token_secret_invalid", "Capability token secret must be a string.");
  }

  const trimmed = value.trim();

  if (trimmed.length < TOKEN_SECRET_MIN_LENGTH) {
    return tokenFailure("token_secret_too_short", "Capability token secret is too short.");
  }

  if (trimmed.length > TOKEN_SECRET_MAX_LENGTH) {
    return tokenFailure("token_secret_too_long", "Capability token secret is too long.");
  }

  if (!TOKEN_SECRET_ALLOWED_CHARACTERS.test(trimmed)) {
    return tokenFailure(
      "token_secret_invalid_characters",
      "Capability token secret has invalid characters.",
    );
  }

  return { ok: true, secret: trimmed as TokenSecret };
}

function tokenFailure(
  code: TokenValidationErrorCode,
  message: string,
): TokenErrorResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function hashFailure(
  code: TokenHashValidationErrorCode,
  message: string,
): TokenHashValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}
