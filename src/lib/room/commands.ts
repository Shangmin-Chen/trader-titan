import {
  createInitialGameState,
  gameReducer,
  startGame as startGameReducer,
} from "../game/reducer";
import { calculateSettlement } from "../game/settlement";
import type {
  GameAction,
  GameState,
  GeneratedItem,
  PlayerId,
  Quote,
  SettledGeneratedItem,
  TradeSide,
} from "../game/types";
import { validateStartGame } from "../game/validation";
import { authorizeRoomAction } from "./authorization";
import type { RoomId } from "./ids";
import type { PresentedCapabilityToken, TokenHash, TokenVerifier } from "./tokens";
import {
  DEFAULT_GUEST_NAME,
  DEFAULT_HOST_NAME,
  DEFAULT_ROOM_MODE,
  DEFAULT_ROOM_TOTAL_ROUNDS,
  GUEST_PLAYER_ID,
  HOST_PLAYER_ID,
  PLAYER_DISPLAY_NAME_MAX_LENGTH,
  roomDomainError,
  type HostSeat,
  type GuestSeat,
  type RoomCommandFailure,
  type RoomCommandResult,
  type RoomDomainErrorCode,
  type RoomGameConfig,
  type RoomPresence,
  type RoomState,
  type UnixTimeMs,
} from "./types";

export type CreateLobbyRoomInput = Readonly<{
  id: RoomId;
  hostTokenHash: TokenHash;
  hostName: string;
  config?: Partial<RoomGameConfig>;
  nowMs: UnixTimeMs;
}>;

export type JoinRoomInput = Readonly<{
  guestTokenHash: TokenHash;
  guestName: string;
  nowMs: UnixTimeMs;
}>;

export type AuthorizedCommandInput = Readonly<{
  credential: PresentedCapabilityToken | null | undefined;
  verifyToken: TokenVerifier;
  nowMs: UnixTimeMs;
}>;

export type PresenceAwareCommandInput = AuthorizedCommandInput &
  Readonly<{
    presence: RoomPresence;
  }>;

export type ConfigureRoomInput = AuthorizedCommandInput &
  Readonly<{
    config: Partial<RoomGameConfig>;
  }>;

export const DEFAULT_ROOM_CONFIG: RoomGameConfig = {
  mode: DEFAULT_ROOM_MODE,
  totalRounds: DEFAULT_ROOM_TOTAL_ROUNDS,
};

const REVISION_INCREMENT = 1;

/**
 * Room creation accepts pre-hashed capabilities so generation and hashing stay
 * owned by the runtime boundary.
 */
export function createLobbyRoom(input: CreateLobbyRoomInput): RoomState {
  const config = normalizeRoomConfig(input.config ?? DEFAULT_ROOM_CONFIG);
  const hostName = normalizeDisplayName(input.hostName, DEFAULT_HOST_NAME);
  const host: HostSeat = {
    role: "host",
    playerId: HOST_PLAYER_ID,
    displayName: hostName,
    tokenHash: input.hostTokenHash,
    joinedAtMs: input.nowMs,
  };

  return {
    id: input.id,
    lifecycle: "lobby",
    config,
    host,
    guest: null,
    game: buildLobbyGame(config, hostName, DEFAULT_GUEST_NAME),
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    revision: 0,
  };
}

export function joinRoom(room: RoomState, input: JoinRoomInput): RoomCommandResult {
  if (room.lifecycle !== "lobby") {
    return commandFailure(room, "room_not_in_lobby", "Guests can only join a lobby room.");
  }

  if (room.guest !== null) {
    return commandFailure(room, "guest_slot_full", "The guest slot is already occupied.");
  }

  const guest: GuestSeat = {
    role: "guest",
    playerId: GUEST_PLAYER_ID,
    displayName: normalizeDisplayName(input.guestName, DEFAULT_GUEST_NAME),
    tokenHash: input.guestTokenHash,
    joinedAtMs: input.nowMs,
  };

  const nextRoom: RoomState = {
    ...room,
    guest,
    game: buildLobbyGame(room.config, room.host.displayName, guest.displayName),
    updatedAtMs: input.nowMs,
    revision: room.revision + REVISION_INCREMENT,
  };

  return { ok: true, room: nextRoom };
}

export function configureRoom(
  room: RoomState,
  input: ConfigureRoomInput,
): RoomCommandResult {
  const authorized = authorizeRoomAction(
    room,
    input.credential,
    { type: "hostControl" },
    input.verifyToken,
  );

  if (!authorized.ok) {
    return { ok: false, room, error: authorized.error };
  }

  if (room.lifecycle !== "lobby") {
    return commandFailure(room, "room_not_in_lobby", "Room configuration is only editable in the lobby.");
  }

  const config = normalizeRoomConfig({
    ...room.config,
    ...input.config,
  });
  const validation = validateRoomConfig(config);

  if (!validation.ok) {
    return commandFailure(room, "invalid_config", validation.error);
  }

  return {
    ok: true,
    room: {
      ...room,
      config,
      game: buildLobbyGame(
        config,
        room.host.displayName,
        room.guest?.displayName ?? DEFAULT_GUEST_NAME,
      ),
      updatedAtMs: input.nowMs,
      revision: room.revision + REVISION_INCREMENT,
    },
  };
}

export function startRoom(
  room: RoomState,
  input: PresenceAwareCommandInput,
): RoomCommandResult {
  const authorized = authorizeRoomAction(
    room,
    input.credential,
    { type: "hostControl" },
    input.verifyToken,
  );

  if (!authorized.ok) {
    return { ok: false, room, error: authorized.error };
  }

  if (room.lifecycle !== "lobby") {
    return commandFailure(room, "room_not_in_lobby", "Only lobby rooms can be started.");
  }

  if (room.guest === null) {
    return commandFailure(room, "guest_required", "A guest must join before the room can start.");
  }

  if (!isPlayerLive(input.presence, GUEST_PLAYER_ID)) {
    return playerOfflineFailure(room);
  }

  const payload = startPayloadForRoom(room);
  const validation = validateStartGame(payload);

  if (!validation.ok) {
    return commandFailure(room, "invalid_config", validation.error);
  }

  const game = startGameReducer(
    buildLobbyGame(room.config, room.host.displayName, room.guest.displayName),
    payload,
  );

  return {
    ok: true,
    room: withGame(room, game, "active", input.nowMs),
  };
}

export function resetRoomToLobby(
  room: RoomState,
  input: AuthorizedCommandInput,
): RoomCommandResult {
  const authorized = authorizeRoomAction(
    room,
    input.credential,
    { type: "hostControl" },
    input.verifyToken,
  );

  if (!authorized.ok) {
    return { ok: false, room, error: authorized.error };
  }

  return {
    ok: true,
    room: {
      ...room,
      lifecycle: "lobby",
      guest: null,
      game: buildLobbyGame(
        room.config,
        room.host.displayName,
        DEFAULT_GUEST_NAME,
      ),
      updatedAtMs: input.nowMs,
      revision: room.revision + REVISION_INCREMENT,
    },
  };
}

export function kickGuest(
  room: RoomState,
  input: AuthorizedCommandInput,
): RoomCommandResult {
  const authorized = authorizeRoomAction(
    room,
    input.credential,
    { type: "hostControl" },
    input.verifyToken,
  );

  if (!authorized.ok) {
    return { ok: false, room, error: authorized.error };
  }

  if (room.guest === null) {
    return commandFailure(room, "guest_slot_empty", "There is no guest to kick.");
  }

  return {
    ok: true,
    room: {
      ...room,
      lifecycle: "lobby",
      guest: null,
      game: buildLobbyGame(room.config, room.host.displayName, DEFAULT_GUEST_NAME),
      updatedAtMs: input.nowMs,
      revision: room.revision + REVISION_INCREMENT,
    },
  };
}

export function receiveRoomItem(
  room: RoomState,
  item: GeneratedItem,
  nowMs: UnixTimeMs,
): RoomCommandResult {
  if (room.lifecycle !== "active") {
    return commandFailure(room, "room_not_active", "Items can only be received by active rooms.");
  }

  if (room.game.phase !== "generatingItem") {
    return commandFailure(room, "invalid_game_phase", "Items can only be received while the room is generating an item.");
  }

  return applySystemGameAction(room, { type: "ITEM_RECEIVED", item }, nowMs);
}

export function failRoomItem(
  room: RoomState,
  error: string,
  nowMs: UnixTimeMs,
): RoomCommandResult {
  if (room.lifecycle !== "active") {
    return commandFailure(room, "room_not_active", "Item failures can only be received by active rooms.");
  }

  if (room.game.phase !== "generatingItem") {
    return commandFailure(room, "invalid_game_phase", "Item failures can only be received while the room is generating an item.");
  }

  return applySystemGameAction(room, { type: "ITEM_FAILED", error }, nowMs);
}

export function submitInitialWidth(
  room: RoomState,
  width: number,
  input: AuthorizedCommandInput,
): RoomCommandResult {
  return applyActivePlayerGameAction(
    room,
    input,
    expectedPlayer(room.game, "SUBMIT_INITIAL_WIDTH"),
    { type: "SUBMIT_INITIAL_WIDTH", width },
  );
}

export function tightenWidth(
  room: RoomState,
  width: number,
  input: AuthorizedCommandInput,
): RoomCommandResult {
  return applyActivePlayerGameAction(
    room,
    input,
    expectedPlayer(room.game, "TIGHTEN_WIDTH"),
    { type: "TIGHTEN_WIDTH", width },
  );
}

export function tradeOnWidth(
  room: RoomState,
  input: AuthorizedCommandInput,
): RoomCommandResult {
  return applyActivePlayerGameAction(
    room,
    input,
    expectedPlayer(room.game, "TRADE_ON_WIDTH"),
    { type: "TRADE_ON_WIDTH" },
  );
}

export function submitMarketQuote(
  room: RoomState,
  quote: Quote,
  input: AuthorizedCommandInput,
): RoomCommandResult {
  return applyActivePlayerGameAction(
    room,
    input,
    expectedPlayer(room.game, "SUBMIT_MARKET_QUOTE"),
    { type: "SUBMIT_MARKET_QUOTE", quote },
  );
}

export function executeTrade(
  room: RoomState,
  side: TradeSide,
  input: AuthorizedCommandInput,
): RoomCommandResult {
  return applyActivePlayerGameAction(
    room,
    input,
    expectedPlayer(room.game, "EXECUTE_TRADE"),
    { type: "EXECUTE_TRADE", side },
  );
}

export function receiveRoomSettlement(
  room: RoomState,
  item: SettledGeneratedItem,
  nowMs: UnixTimeMs,
): RoomCommandResult {
  if (room.lifecycle !== "active") {
    return commandFailure(room, "room_not_active", "Settlements can only be received by active rooms.");
  }

  if (room.game.phase !== "settling") {
    return commandFailure(room, "invalid_game_phase", "Settlements can only be received while the room is settling.");
  }

  const settlement = calculateSettlement({
    roundNumber: room.game.roundNumber,
    itemTitle: room.game.item.item_title,
    trueValue: item.true_value,
    quote: room.game.quote,
    side: room.game.pendingSide,
    roles: room.game.roles,
  });

  return applySystemGameAction(
    room,
    { type: "SETTLEMENT_RECEIVED", item, settlement },
    nowMs,
  );
}

export function failRoomSettlement(
  room: RoomState,
  error: string,
  nowMs: UnixTimeMs,
): RoomCommandResult {
  if (room.lifecycle !== "active") {
    return commandFailure(room, "room_not_active", "Settlement failures can only be received by active rooms.");
  }

  if (room.game.phase !== "settling") {
    return commandFailure(room, "invalid_game_phase", "Settlement failures can only be received while the room is settling.");
  }

  return applySystemGameAction(room, { type: "SETTLEMENT_FAILED", error }, nowMs);
}

export function advanceRoomRound(
  room: RoomState,
  input: PresenceAwareCommandInput,
): RoomCommandResult {
  const authorized = authorizeRoomAction(
    room,
    input.credential,
    { type: "hostControl" },
    input.verifyToken,
  );

  if (!authorized.ok) {
    return { ok: false, room, error: authorized.error };
  }

  if (room.lifecycle !== "active") {
    return commandFailure(room, "room_not_active", "Only active rooms can advance rounds.");
  }

  if (room.game.phase !== "settlement") {
    return commandFailure(room, "invalid_game_phase", "Rounds can only advance after settlement.");
  }

  if (
    !isFinalRoundSettlement(room.game) &&
    !isPlayerLive(input.presence, GUEST_PLAYER_ID)
  ) {
    return playerOfflineFailure(room);
  }

  return applySystemGameAction(room, { type: "NEXT_ROUND" }, input.nowMs);
}

function applyActivePlayerGameAction(
  room: RoomState,
  input: AuthorizedCommandInput,
  playerId: PlayerId | null,
  action: GameAction,
): RoomCommandResult {
  if (room.lifecycle !== "active") {
    return commandFailure(room, "room_not_active", "Only active rooms accept game commands.");
  }

  if (playerId === null) {
    return commandFailure(room, "invalid_game_phase", "This command is not valid in the current game phase.");
  }

  const authorized = authorizeRoomAction(
    room,
    input.credential,
    { type: "activePlayer", playerId },
    input.verifyToken,
  );

  if (!authorized.ok) {
    return { ok: false, room, error: authorized.error };
  }

  return applySystemGameAction(room, action, input.nowMs);
}

function applySystemGameAction(
  room: RoomState,
  action: GameAction,
  nowMs: UnixTimeMs,
): RoomCommandResult {
  const game = gameReducer(room.game, action);

  if (game === room.game) {
    return commandFailure(room, "invalid_game_phase", "This command is not valid in the current game phase.");
  }

  return {
    ok: true,
    room: withGame(room, game, lifecycleForGame(game), nowMs),
  };
}

function withGame(
  room: RoomState,
  game: GameState,
  lifecycle: RoomState["lifecycle"],
  nowMs: UnixTimeMs,
): RoomState {
  return {
    ...room,
    lifecycle,
    game,
    updatedAtMs: nowMs,
    revision: room.revision + REVISION_INCREMENT,
  };
}

function expectedPlayer(game: GameState, actionType: GameAction["type"]): PlayerId | null {
  switch (actionType) {
    case "SUBMIT_INITIAL_WIDTH":
      return game.phase === "proposingWidth" ? game.roles.marketMaker : null;
    case "TIGHTEN_WIDTH":
    case "TRADE_ON_WIDTH":
      return game.phase === "negotiatingWidth" ? game.roles.trader : null;
    case "SUBMIT_MARKET_QUOTE":
      return game.phase === "configuringMarket" ? game.roles.marketMaker : null;
    case "EXECUTE_TRADE":
      return game.phase === "choosingSide" ? game.roles.trader : null;
    default:
      return null;
  }
}

function lifecycleForGame(game: GameState): RoomState["lifecycle"] {
  return game.phase === "gameOver" ? "finished" : "active";
}

function isFinalRoundSettlement(game: GameState): boolean {
  return game.phase === "settlement" && game.roundNumber >= game.totalRounds;
}

function isPlayerLive(presence: RoomPresence, playerId: PlayerId): boolean {
  return presence.players[playerId] === true;
}

function buildLobbyGame(
  config: RoomGameConfig,
  hostName: string,
  guestName: string,
): GameState {
  return createInitialGameState({
    mode: config.mode,
    totalRounds: config.totalRounds,
    players: {
      A: { name: hostName },
      B: { name: guestName },
    },
  });
}

function startPayloadForRoom(room: RoomState): Parameters<typeof startGameReducer>[1] {
  return {
    playerAName: room.host.displayName,
    playerBName: room.guest?.displayName ?? DEFAULT_GUEST_NAME,
    mode: room.config.mode,
    totalRounds: room.config.totalRounds,
    customAmazonQuery: room.config.customAmazonQuery,
  };
}

function normalizeRoomConfig(config: Partial<RoomGameConfig>): RoomGameConfig {
  const baseConfig = {
    mode: config.mode ?? DEFAULT_ROOM_CONFIG.mode,
    totalRounds: config.totalRounds ?? DEFAULT_ROOM_CONFIG.totalRounds,
  };

  if (baseConfig.mode === "Amazon" && config.customAmazonQuery === true) {
    return {
      ...baseConfig,
      customAmazonQuery: true,
    };
  }

  return baseConfig;
}

function validateRoomConfig(
  config: RoomGameConfig,
): Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }> {
  const validation = validateStartGame({
    playerAName: DEFAULT_HOST_NAME,
    playerBName: DEFAULT_GUEST_NAME,
    mode: config.mode,
    totalRounds: config.totalRounds,
    customAmazonQuery: config.customAmazonQuery,
  });

  return validation.ok ? { ok: true } : { ok: false, error: validation.error };
}

function normalizeDisplayName(value: string, fallback: string): string {
  const trimmed = value.trim();
  const name = trimmed.length > 0 ? trimmed : fallback;

  return name.length > PLAYER_DISPLAY_NAME_MAX_LENGTH
    ? name.slice(0, PLAYER_DISPLAY_NAME_MAX_LENGTH)
    : name;
}

function commandFailure(
  room: RoomState,
  code: RoomDomainErrorCode,
  message: string,
): RoomCommandFailure {
  return {
    ok: false,
    room,
    error: roomDomainError(code, message),
  };
}

function playerOfflineFailure(room: RoomState): RoomCommandFailure {
  return commandFailure(
    room,
    "player_offline",
    "Player B must be connected before the room can continue.",
  );
}
