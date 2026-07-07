import { calculateSettlement } from "../game/settlement";
import {
  GAME_MODES,
  MAX_ROUNDS,
  type GameMode,
  type GamePhase,
  type GameState,
  type GeneratedItem,
  type PlayerId,
  type ProviderGeneratedItem,
  type Quote,
  type Roles,
  type RoundLogEntry,
  type RoundSettlement,
  type ScrapedAmazonItem,
  type Scores,
  type SettledGeneratedItem,
  type TradeSide,
} from "../game/types";
import {
  validateProviderItem,
  validateQuoteForWidth,
  validateSpreadWidth,
} from "../game/validation";
import { parseRoomId } from "./ids";
import { parseTokenHash, type TokenHash } from "./tokens";
import {
  roomDomainError,
  type RoomDomainError,
  type GuestSeat,
  type HostSeat,
  type RoomGameConfig,
  type RoomLifecycle,
  type RoomSeat,
  type RoomState,
  type UnixTimeMs,
} from "./types";

const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const ABANDONED_ROOM_HOURS = 2;
const FINISHED_ROOM_MINUTES = 15;

export const ABANDONED_ROOM_TTL_MS =
  ABANDONED_ROOM_HOURS *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MILLISECONDS_PER_SECOND;

export const FINISHED_ROOM_TTL_MS =
  FINISHED_ROOM_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export const ROOM_PERSISTENCE_KIND = "trader-titan.room";
export const ROOM_PERSISTENCE_VERSION = 1;

export type PersistedRoomEnvelope = Readonly<{
  kind: typeof ROOM_PERSISTENCE_KIND;
  version: typeof ROOM_PERSISTENCE_VERSION;
  persistedAtMs: UnixTimeMs;
  expiresAtMs: UnixTimeMs;
  room: RoomState;
}>;

export type PersistenceLoadResult =
  | Readonly<{ ok: true; room: RoomState }>
  | Readonly<{ ok: false; error: RoomDomainError }>;

/**
 * Persistence is intentionally private: it keeps credential hashes and should
 * never be returned to clients instead of a public snapshot.
 */
export function toPersistenceEnvelope(
  room: RoomState,
  persistedAtMs: UnixTimeMs,
): PersistedRoomEnvelope {
  return {
    kind: ROOM_PERSISTENCE_KIND,
    version: ROOM_PERSISTENCE_VERSION,
    persistedAtMs,
    expiresAtMs: roomExpiresAtMs(room),
    room,
  };
}

export function loadPersistenceEnvelope(
  envelope: unknown,
  nowMs: UnixTimeMs,
): PersistenceLoadResult {
  if (!isRecord(envelope) || envelope.kind !== ROOM_PERSISTENCE_KIND) {
    return persistenceInvalid();
  }

  if (envelope.version !== ROOM_PERSISTENCE_VERSION) {
    return {
      ok: false,
      error: roomDomainError(
        "persistence_version_unsupported",
        "Room persistence version is not supported.",
      ),
    };
  }

  if (!isUnixTimeMs(envelope.persistedAtMs) || !isUnixTimeMs(envelope.expiresAtMs)) {
    return persistenceInvalid();
  }

  const room = decodeRoomState(envelope.room);

  if (room === null) {
    return persistenceInvalid();
  }

  if (envelope.expiresAtMs !== roomExpiresAtMs(room)) {
    return persistenceInvalid();
  }

  if (nowMs >= envelope.expiresAtMs) {
    return {
      ok: false,
      error: roomDomainError("persistence_expired", "Room persistence envelope has expired."),
    };
  }

  return { ok: true, room };
}

export function roomExpiresAtMs(room: RoomState): UnixTimeMs {
  return room.updatedAtMs + roomTtlMs(room);
}

export function roomTtlMs(room: RoomState): UnixTimeMs {
  return room.lifecycle === "finished" ? FINISHED_ROOM_TTL_MS : ABANDONED_ROOM_TTL_MS;
}

export function isRoomExpired(room: RoomState, nowMs: UnixTimeMs): boolean {
  return nowMs >= roomExpiresAtMs(room);
}

function decodeRoomState(value: unknown): RoomState | null {
  if (!isRecord(value)) {
    return null;
  }

  const roomId = parseRoomId(value.id);
  const lifecycle = decodeLifecycle(value.lifecycle);
  const config = decodeRoomGameConfig(value.config);
  const host = decodeSeat(value.host, "host");
  const guest = value.guest === null ? null : decodeSeat(value.guest, "guest");
  const game = decodeGameState(value.game);
  const guestSeatInvalid = value.guest !== null && guest === null;

  if (
    !roomId.ok ||
    lifecycle === null ||
    config === null ||
    host === null ||
    guestSeatInvalid ||
    game === null ||
    !isLifecycleGameConsistent(lifecycle, game) ||
    !isUnixTimeMs(value.createdAtMs) ||
    !isUnixTimeMs(value.updatedAtMs) ||
    value.createdAtMs > value.updatedAtMs ||
    !isNonNegativeInteger(value.revision)
  ) {
    return null;
  }

  return {
    id: roomId.roomId,
    lifecycle,
    config,
    host,
    guest,
    game,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
    revision: value.revision,
  };
}

function decodeLifecycle(value: unknown): RoomLifecycle | null {
  return value === "lobby" || value === "active" || value === "finished"
    ? value
    : null;
}

function decodeRoomGameConfig(value: unknown): RoomGameConfig | null {
  if (!isRecord(value) || !isGameMode(value.mode) || !isTotalRounds(value.totalRounds)) {
    return null;
  }

  if (
    value.customAmazonQuery !== undefined &&
    typeof value.customAmazonQuery !== "boolean"
  ) {
    return null;
  }

  if (
    value.aiGenerated !== undefined &&
    typeof value.aiGenerated !== "boolean"
  ) {
    return null;
  }

  return {
    mode: value.mode,
    totalRounds: value.totalRounds,
    ...(value.customAmazonQuery === true ? { customAmazonQuery: true } : {}),
    ...(value.aiGenerated === true ? { aiGenerated: true } : {}),
  };
}

function decodeSeat(value: unknown, role: "host"): HostSeat | null;
function decodeSeat(value: unknown, role: "guest"): GuestSeat | null;
function decodeSeat(value: unknown, role: RoomSeat["role"]): RoomSeat | null {
  if (!isRecord(value) || value.role !== role || typeof value.displayName !== "string") {
    return null;
  }

  const expectedPlayerId = role === "host" ? "A" : "B";
  if (value.playerId !== expectedPlayerId || !isUnixTimeMs(value.joinedAtMs)) {
    return null;
  }

  const tokenHash = decodeTokenHash(value.tokenHash);
  if (tokenHash === null) {
    return null;
  }

  return {
    role,
    playerId: expectedPlayerId,
    displayName: value.displayName,
    tokenHash,
    joinedAtMs: value.joinedAtMs,
  } as RoomSeat;
}

function decodeGameState(value: unknown): GameState | null {
  if (!isRecord(value) || !isGameStateBase(value)) {
    return null;
  }

  switch (value.phase) {
    case "setup":
    case "generatingItem":
      return hasOnlyKeys(value, baseGameKeysFor(value)) ? value as GameState : null;
    case "proposingWidth":
      return hasOnlyKeys(value, [...baseGameKeysFor(value), "item"]) &&
        isGeneratedItem(value.item) &&
        isActiveRoundNumber(value)
        ? value as GameState
        : null;
    case "negotiatingWidth":
    case "configuringMarket":
      return hasOnlyKeys(value, [...baseGameKeysFor(value), "item", "spreadWidth"]) &&
        isGeneratedItem(value.item) &&
        isValidSpreadWidth(value.spreadWidth) &&
        isActiveRoundNumber(value)
        ? value as GameState
        : null;
    case "choosingSide":
      return hasOnlyKeys(value, [...baseGameKeysFor(value), "item", "spreadWidth", "quote"]) &&
        isGeneratedItem(value.item) &&
        isValidSpreadWidth(value.spreadWidth) &&
        isQuoteForWidth(value.quote, value.spreadWidth) &&
        isActiveRoundNumber(value)
        ? value as GameState
        : null;
    case "settling":
      return hasOnlyKeys(value, [...baseGameKeysFor(value), "item", "spreadWidth", "quote", "pendingSide"]) &&
        isGeneratedItem(value.item) &&
        isValidSpreadWidth(value.spreadWidth) &&
        isQuoteForWidth(value.quote, value.spreadWidth) &&
        isTradeSide(value.pendingSide) &&
        isActiveRoundNumber(value)
        ? value as GameState
        : null;
    case "settlement":
      return hasOnlyKeys(value, [...baseGameKeysFor(value), "item", "spreadWidth", "quote", "settlement"]) &&
        isSettledGeneratedItem(value.item) &&
        isValidSpreadWidth(value.spreadWidth) &&
        isQuoteForWidth(value.quote, value.spreadWidth) &&
        isRoundSettlement(value.settlement) &&
        isActiveRoundNumber(value) &&
        isSettlementConsistent(value)
        ? value as GameState
        : null;
    case "gameOver":
      return hasOnlyKeys(value, [...baseGameKeysFor(value), "winner"]) &&
        (value.winner === "A" || value.winner === "B" || value.winner === "Tie") &&
        isActiveRoundNumber(value)
        ? value as GameState
        : null;
    case "error":
      return hasOnlyKeys(value, [...baseGameKeysFor(value), "error", "previousPhase"]) &&
        typeof value.error === "string" &&
        isGamePhase(value.previousPhase)
        ? value as GameState
        : null;
    default:
      return null;
  }
}

function isGameStateBase(value: Record<string, unknown>): boolean {
  return isGamePhase(value.phase) &&
    isGameMode(value.mode) &&
    (value.customAmazonQuery === undefined ||
      typeof value.customAmazonQuery === "boolean") &&
    (value.aiGenerated === undefined ||
      typeof value.aiGenerated === "boolean") &&
    isPlayers(value.players) &&
    isScores(value.scores) &&
    isRoles(value.roles) &&
    isNonNegativeInteger(value.roundNumber) &&
    isTotalRounds(value.totalRounds) &&
    isRoundLog(value.log) &&
    (value.lastError === undefined || typeof value.lastError === "string");
}

function baseGameKeysFor(value: Record<string, unknown>): string[] {
  return [
    "phase",
    "mode",
    "players",
    "scores",
    "roles",
    "roundNumber",
    "totalRounds",
    "log",
    ...(value.customAmazonQuery === undefined ? [] : ["customAmazonQuery"]),
    ...(value.aiGenerated === undefined ? [] : ["aiGenerated"]),
    ...(value.lastError === undefined ? [] : ["lastError"]),
  ];
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlayers(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return isPlayer(value.A, "A") && isPlayer(value.B, "B");
}

function isPlayer(value: unknown, id: PlayerId): boolean {
  return isRecord(value) && value.id === id && typeof value.name === "string";
}

function isScores(value: unknown): value is Scores {
  return isRecord(value) && isFiniteNumber(value.A) && isFiniteNumber(value.B);
}

function isRoles(value: unknown): value is Roles {
  return isRecord(value) &&
    isPlayerId(value.marketMaker) &&
    isPlayerId(value.trader) &&
    value.marketMaker !== value.trader;
}

function isRoundLog(value: unknown): value is RoundLogEntry[] {
  return Array.isArray(value) &&
    value.every((entry) =>
      isRecord(entry) &&
      isPositiveInteger(entry.id) &&
      isNonNegativeInteger(entry.roundNumber) &&
      isGamePhase(entry.phase) &&
      typeof entry.message === "string",
    );
}

function isGeneratedItem(value: unknown): value is GeneratedItem {
  return isRecord(value) &&
    hasOnlyKeys(value, ["round_id", "item_title", "category", "context_clue"]) &&
    typeof value.round_id === "string" &&
    typeof value.item_title === "string" &&
    typeof value.category === "string" &&
    typeof value.context_clue === "string";
}

function isSettledGeneratedItem(value: unknown): value is SettledGeneratedItem {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "round_id",
      "item_title",
      "category",
      "context_clue",
      "true_value",
      ...(value.scraped_items === undefined ? [] : ["scraped_items"]),
      ...(value.amazon_url === undefined ? [] : ["amazon_url"]),
    ]) ||
    typeof value.round_id !== "string" ||
    typeof value.item_title !== "string" ||
    typeof value.category !== "string" ||
    typeof value.context_clue !== "string" ||
    !isFiniteNumber(value.true_value)
  ) {
    return false;
  }

  if (
    value.scraped_items !== undefined &&
    !isScrapedAmazonItems(value.scraped_items)
  ) {
    return false;
  }

  if (value.amazon_url !== undefined && typeof value.amazon_url !== "string") {
    return false;
  }

  return validateProviderItem(value as ProviderGeneratedItem).ok;
}

function isScrapedAmazonItems(value: unknown): value is ScrapedAmazonItem[] {
  return Array.isArray(value) &&
    value.every((item) =>
      isRecord(item) &&
      hasOnlyKeys(item, ["title", "price"]) &&
      typeof item.title === "string" &&
      isFiniteNumber(item.price),
    );
}

function isQuote(value: unknown): value is Quote {
  return isRecord(value) && isFiniteNumber(value.bid) && isFiniteNumber(value.ask);
}

function isValidSpreadWidth(value: unknown): value is number {
  return typeof value === "number" && validateSpreadWidth(value).ok;
}

function isQuoteForWidth(value: unknown, spreadWidth: unknown): value is Quote {
  return isQuote(value) &&
    typeof spreadWidth === "number" &&
    validateQuoteForWidth(value, spreadWidth).ok;
}

function isRoundSettlement(value: unknown): value is RoundSettlement {
  return isRecord(value) &&
    isPositiveInteger(value.roundNumber) &&
    typeof value.itemTitle === "string" &&
    isTradeSide(value.side) &&
    isFiniteNumber(value.transactionPrice) &&
    isFiniteNumber(value.trueValue) &&
    isPlayerId(value.trader) &&
    isPlayerId(value.marketMaker) &&
    value.trader !== value.marketMaker &&
    isFiniteNumber(value.traderPnL) &&
    isFiniteNumber(value.marketMakerPnL);
}

function isSettlementConsistent(value: Record<string, unknown>): boolean {
  const settlement = value.settlement;

  if (
    !isSettledGeneratedItem(value.item) ||
    !isQuote(value.quote) ||
    !isRoles(value.roles) ||
    !isPositiveInteger(value.roundNumber) ||
    !isRoundSettlement(settlement)
  ) {
    return false;
  }

  const expected = calculateSettlement({
    roundNumber: value.roundNumber,
    itemTitle: value.item.item_title,
    trueValue: value.item.true_value,
    quote: value.quote,
    side: settlement.side,
    roles: value.roles,
  });

  return roundSettlementsEqual(settlement, expected);
}

function roundSettlementsEqual(
  left: RoundSettlement,
  right: RoundSettlement,
): boolean {
  return left.roundNumber === right.roundNumber &&
    left.itemTitle === right.itemTitle &&
    left.side === right.side &&
    left.transactionPrice === right.transactionPrice &&
    left.trueValue === right.trueValue &&
    left.trader === right.trader &&
    left.marketMaker === right.marketMaker &&
    left.traderPnL === right.traderPnL &&
    left.marketMakerPnL === right.marketMakerPnL;
}

function decodeTokenHash(value: unknown): TokenHash | null {
  const result = parseTokenHash(value);
  return result.ok ? result.tokenHash : null;
}

function isGameMode(value: unknown): value is GameMode {
  return typeof value === "string" && GAME_MODES.includes(value as GameMode);
}

function isGamePhase(value: unknown): value is GamePhase {
  return typeof value === "string" &&
    (
      value === "setup" ||
      value === "generatingItem" ||
      value === "proposingWidth" ||
      value === "negotiatingWidth" ||
      value === "configuringMarket" ||
      value === "choosingSide" ||
      value === "settling" ||
      value === "settlement" ||
      value === "gameOver" ||
      value === "error"
    );
}

function isTradeSide(value: unknown): value is TradeSide {
  return value === "BUY" || value === "SELL";
}

function isPlayerId(value: unknown): value is PlayerId {
  return value === "A" || value === "B";
}

function isTotalRounds(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_ROUNDS;
}

function isActiveRoundNumber(
  value: Readonly<{ roundNumber?: unknown; totalRounds?: unknown }>,
): boolean {
  return isPositiveInteger(value.roundNumber) &&
    isTotalRounds(value.totalRounds) &&
    value.roundNumber <= value.totalRounds;
}

function isLifecycleGameConsistent(
  lifecycle: RoomLifecycle,
  game: GameState,
): boolean {
  if (lifecycle === "lobby") {
    return game.phase === "setup";
  }

  if (lifecycle === "finished") {
    return game.phase === "gameOver";
  }

  return game.phase !== "setup" && game.phase !== "gameOver";
}

function isUnixTimeMs(value: unknown): value is UnixTimeMs {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistenceInvalid(): PersistenceLoadResult {
  return {
    ok: false,
    error: roomDomainError("persistence_invalid", "Room persistence envelope is invalid."),
  };
}
