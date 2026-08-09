import { calculateSettlement } from "../game/settlement";
import {
  CHOOSING_SIDE_TURN_DURATION_MS,
  CONFIGURING_MARKET_TURN_DURATION_MS,
  GAME_MODES,
  MAX_ROUNDS,
  NEGOTIATING_WIDTH_TURN_DURATION_MS,
  PROPOSING_WIDTH_TURN_DURATION_MS,
  SETTLEMENT_FAILURE_EPISODE_CAP,
  type GameMode,
  type GamePhase,
  type GameState,
  type GeneratedItem,
  type PendingTradeDecision,
  type PlayerId,
  type ProviderGeneratedItem,
  type Quote,
  type Roles,
  type RoundForfeit,
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
export const ROOM_PERSISTENCE_VERSION = 3;

/**
 * The oldest prior envelope version this decoder still accepts and migrates
 * forward on read (see decodeRoomState/migrateGameStateRecordForward below).
 * Every version from this floor up to (but excluding) ROOM_PERSISTENCE_VERSION
 * is "legacy": readable, but only after being walked forward one step at a
 * time through the chain of per-version migration functions.
 *
 * Version 1 predates F-05's turnDeadlineMs and F-06's pendingTrade
 * (previously pendingSide) / RoundSettlement.forcedByTimeout. Version 2
 * predates F-07's settlementFailureCount (on `settling`) and its paired,
 * optional counterpart on a locked `choosingSide` - fields the strict
 * per-phase allowlists below now require. Bumping ROOM_PERSISTENCE_VERSION
 * without also migrating made every older envelope already sitting in
 * production storage fail to decode (persistence_invalid) the moment the new
 * shape shipped, since nothing had rewritten them yet.
 *
 * Every future shape change to a phase's persisted keys needs the same
 * treatment: bump ROOM_PERSISTENCE_VERSION, add a new
 * migrateVN-1ToVNGameStateRecord step to the chain in
 * migrateGameStateRecordForward, and extend the range this floor plus that
 * chain covers - never collapse back down to a single hardcoded "previous
 * version", since two migrations already had to compose here and a third
 * shape change will need to compose with both of them.
 */
const ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION = 1;

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

  // A legacy envelope (anything from ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION
  // up to, but excluding, the current version) is decoded through the same
  // strict per-phase allowlists as the current version, just after
  // normalizing its game-state record forward to the current shape first -
  // see migrateGameStateRecordForward. A version outside that supported
  // range entirely is genuinely unsupported (a future version this build
  // predates, an ancient one this build no longer carries a migration path
  // for, or a bogus value), not something to guess at.
  const version = envelope.version;

  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION ||
    version > ROOM_PERSISTENCE_VERSION
  ) {
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

  const room = decodeRoomState(envelope.room, { version, nowMs });

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

/**
 * Carries what a legacy-envelope migration needs through the decode
 * pipeline: the envelope's own persisted version, which determines how many
 * migration steps (if any) migrateGameStateRecordForward must chain before
 * the (unmodified) strict current-version checks run, and the reader's
 * current time - needed only for stamping a fresh turnDeadlineMs (see
 * withFreshTurnDeadline) since a version-1 record never had one to recover.
 */
type DecodeContext = Readonly<{ version: number; nowMs: UnixTimeMs }>;

function decodeRoomState(value: unknown, ctx: DecodeContext): RoomState | null {
  if (!isRecord(value)) {
    return null;
  }

  const roomId = parseRoomId(value.id);
  const lifecycle = decodeLifecycle(value.lifecycle);
  const config = decodeRoomGameConfig(value.config);
  const host = decodeSeat(value.host, "host");
  const guest = value.guest === null ? null : decodeSeat(value.guest, "guest");
  const game = decodeGameState(value.game, ctx);
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

function decodeGameState(value: unknown, ctx: DecodeContext): GameState | null {
  if (!isRecord(value) || !isGameStateBase(value)) {
    return null;
  }

  // Normalize a legacy record forward to the current (version-3) shape
  // first, then run it through exactly the same strict checks below as a
  // native current-version record - see migrateGameStateRecordForward. A
  // legacy record that does not actually match its claimed prior shape
  // (e.g. a stray turnDeadlineMs already present, or genuine corruption) is
  // left as-is here and then correctly rejected by the unmodified allowlist
  // checks that follow.
  const migrated = ctx.version === ROOM_PERSISTENCE_VERSION
    ? value
    : migrateGameStateRecordForward(value, ctx.version, ctx.nowMs);

  switch (migrated.phase) {
    case "setup":
    case "generatingItem":
      return hasOnlyKeys(migrated, baseGameKeysFor(migrated)) ? migrated as GameState : null;
    case "proposingWidth":
      return hasOnlyKeys(migrated, [...baseGameKeysFor(migrated), "item", "turnDeadlineMs"]) &&
        isGeneratedItem(migrated.item) &&
        isUnixTimeMs(migrated.turnDeadlineMs) &&
        isActiveRoundNumber(migrated)
        ? migrated as GameState
        : null;
    case "negotiatingWidth":
    case "configuringMarket":
      return hasOnlyKeys(migrated, [...baseGameKeysFor(migrated), "item", "spreadWidth", "turnDeadlineMs"]) &&
        isGeneratedItem(migrated.item) &&
        isValidSpreadWidth(migrated.spreadWidth) &&
        isUnixTimeMs(migrated.turnDeadlineMs) &&
        isActiveRoundNumber(migrated)
        ? migrated as GameState
        : null;
    case "choosingSide":
      return hasOnlyKeys(migrated, [
        ...baseGameKeysFor(migrated),
        "item",
        "spreadWidth",
        "quote",
        "turnDeadlineMs",
        ...(migrated.lockedPendingTrade === undefined ? [] : ["lockedPendingTrade"]),
        ...(migrated.settlementFailureCount === undefined ? [] : ["settlementFailureCount"]),
      ]) &&
        isGeneratedItem(migrated.item) &&
        isValidSpreadWidth(migrated.spreadWidth) &&
        isQuoteForWidth(migrated.quote, migrated.spreadWidth) &&
        isUnixTimeMs(migrated.turnDeadlineMs) &&
        (migrated.lockedPendingTrade === undefined ||
          isPendingTradeDecision(migrated.lockedPendingTrade)) &&
        // F-07: lockedPendingTrade and settlementFailureCount are only ever
        // set together, both by SETTLEMENT_FAILED (see
        // ChoosingSideGameState's doc comment on settlementFailureCount) -
        // reject a persisted state that has drifted to carrying only one of
        // the pair rather than silently accepting an illegal blend.
        (migrated.lockedPendingTrade === undefined) ===
          (migrated.settlementFailureCount === undefined) &&
        (migrated.settlementFailureCount === undefined ||
          isSettlementFailureCount(migrated.settlementFailureCount)) &&
        isActiveRoundNumber(migrated)
        ? migrated as GameState
        : null;
    case "settling":
      return hasOnlyKeys(migrated, [
        ...baseGameKeysFor(migrated),
        "item",
        "spreadWidth",
        "quote",
        "pendingTrade",
        "settlementFailureCount",
      ]) &&
        isGeneratedItem(migrated.item) &&
        isValidSpreadWidth(migrated.spreadWidth) &&
        isQuoteForWidth(migrated.quote, migrated.spreadWidth) &&
        isPendingTradeDecision(migrated.pendingTrade) &&
        isSettlementFailureCount(migrated.settlementFailureCount) &&
        isActiveRoundNumber(migrated)
        ? migrated as GameState
        : null;
    case "settlement":
      return hasOnlyKeys(migrated, [...baseGameKeysFor(migrated), "item", "spreadWidth", "quote", "settlement"]) &&
        isSettledGeneratedItem(migrated.item) &&
        isValidSpreadWidth(migrated.spreadWidth) &&
        isQuoteForWidth(migrated.quote, migrated.spreadWidth) &&
        isRoundSettlement(migrated.settlement) &&
        isActiveRoundNumber(migrated) &&
        isSettlementConsistent(migrated)
        ? migrated as GameState
        : null;
    case "roundForfeited":
      return hasOnlyKeys(migrated, [...baseGameKeysFor(migrated), "forfeit"]) &&
        isRoundForfeit(migrated.forfeit) &&
        isActiveRoundNumber(migrated)
        ? migrated as GameState
        : null;
    case "gameOver":
      return hasOnlyKeys(migrated, [...baseGameKeysFor(migrated), "winner"]) &&
        (migrated.winner === "A" || migrated.winner === "B" || migrated.winner === "Tie") &&
        isActiveRoundNumber(migrated)
        ? migrated as GameState
        : null;
    case "error":
      return hasOnlyKeys(migrated, [...baseGameKeysFor(migrated), "error", "previousPhase"]) &&
        typeof migrated.error === "string" &&
        isGamePhase(migrated.previousPhase)
        ? migrated as GameState
        : null;
    default:
      return null;
  }
}

/**
 * Walks a game-state record forward from whatever version it was actually
 * persisted at (`fromVersion`) up to the current shape, one migration step
 * at a time. Each step only knows how to migrate from its own immediate
 * predecessor version, so a version-1 record gets both steps applied in
 * order - migrateV1ToV2GameStateRecord's output feeds directly into
 * migrateV2ToV3GameStateRecord - while a version-2 record only gets the
 * second. This composes rather than branching on fromVersion directly
 * inside each step, which is what lets a future version bump add a third
 * `if (fromVersion < 4) { ... }` here without touching the two that already
 * exist.
 */
function migrateGameStateRecordForward(
  value: Record<string, unknown>,
  fromVersion: number,
  nowMs: UnixTimeMs,
): Record<string, unknown> {
  let record = value;

  if (fromVersion < 2) {
    record = migrateV1ToV2GameStateRecord(record, nowMs);
  }

  if (fromVersion < 3) {
    record = migrateV2ToV3GameStateRecord(record);
  }

  return record;
}

/**
 * Forward-migrates a version-1 game-state record to the version-2 shape
 * (see ROOM_PERSISTENCE_MIN_SUPPORTED_VERSION). Only touches the specific
 * fields each shape gained; everything else - including phases with no
 * shape change at all, like `setup` or `gameOver` - passes through
 * untouched, so a legacy record that is *actually* corrupt still falls
 * through to fail the unmodified current-version checks in decodeGameState
 * above rather than being silently coerced into something valid.
 */
function migrateV1ToV2GameStateRecord(
  value: Record<string, unknown>,
  nowMs: UnixTimeMs,
): Record<string, unknown> {
  switch (value.phase) {
    case "proposingWidth":
      return withFreshTurnDeadline(value, nowMs, PROPOSING_WIDTH_TURN_DURATION_MS);
    case "negotiatingWidth":
      return withFreshTurnDeadline(value, nowMs, NEGOTIATING_WIDTH_TURN_DURATION_MS);
    case "configuringMarket":
      return withFreshTurnDeadline(value, nowMs, CONFIGURING_MARKET_TURN_DURATION_MS);
    case "choosingSide":
      return withFreshTurnDeadline(value, nowMs, CHOOSING_SIDE_TURN_DURATION_MS);
    case "settling":
      return withMigratedPendingTrade(value);
    case "settlement":
      return withDefaultedForcedByTimeout(value);
    default:
      return value;
  }
}

/**
 * Forward-migrates a version-2 game-state record to the version-3 shape:
 * F-07's settlementFailureCount, required on `settling` and optionally
 * paired with `lockedPendingTrade` on a locked `choosingSide`. A version-2
 * record predates F-07 entirely, so it can only ever represent zero prior
 * failed settling episodes for whatever round it is mid-round in - see
 * withDefaultedSettlementFailureCount and
 * withDefaultedLockedSettlementFailureCount for why that default is safe on
 * each phase.
 */
function migrateV2ToV3GameStateRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  switch (value.phase) {
    case "settling":
      return withDefaultedSettlementFailureCount(value);
    case "choosingSide":
      return withDefaultedLockedSettlementFailureCount(value);
    default:
      return value;
  }
}

function withFreshTurnDeadline(
  value: Record<string, unknown>,
  nowMs: UnixTimeMs,
  turnDurationMs: number,
): Record<string, unknown> {
  if (value.turnDeadlineMs !== undefined) {
    return value;
  }

  // F-05's shot clock did not exist when a version-1 envelope was written,
  // so there is no real prior deadline to recover - only a choice about how
  // much time to grant now. Stamping nowMs (the reader's current time) plus
  // a full fresh turn - rather than, say, an already-elapsed deadline - is
  // the deliberate gameplay call here: a player who was mid-turn across this
  // deploy gets a full turn to act, the same as if the deploy had simply
  // landed a moment later and the normal ITEM_RECEIVED / SUBMIT_INITIAL_WIDTH
  // / TIGHTEN_WIDTH / TRADE_ON_WIDTH / SUBMIT_MARKET_QUOTE transition had
  // stamped this turnDeadlineMs a moment after. The alternative - treating a
  // migrated room as already on the clock from whenever it was last
  // persisted - would let an ordinary deploy instantly forfeit rounds for
  // players who did nothing wrong.
  return { ...value, turnDeadlineMs: nowMs + turnDurationMs };
}

function withMigratedPendingTrade(value: Record<string, unknown>): Record<string, unknown> {
  if (value.pendingTrade !== undefined || value.pendingSide === undefined) {
    return value;
  }

  // F-06's timeoutForcedWorstSide path did not exist when a version-1
  // "settling" envelope was written, so a stored pendingSide can only ever
  // represent a trader's own EXECUTE_TRADE choice - never a clock-forced
  // one - and migrates 1:1 into PendingTradeDecision's "chosen" variant.
  const { pendingSide, ...rest } = value;
  return { ...rest, pendingTrade: { kind: "chosen", side: pendingSide } };
}

function withDefaultedForcedByTimeout(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.settlement) || value.settlement.forcedByTimeout !== undefined) {
    return value;
  }

  // Same reasoning as withMigratedPendingTrade: F-06 did not exist yet, so a
  // version-1 RoundSettlement can never have been timeout-forced.
  // forcedByTimeout only ever accompanies calculateSettlement's other
  // outputs and does not itself affect transactionPrice/PnL (see
  // settlement.ts), so defaulting it to false here reproduces exactly what
  // the pre-F-06 settlement math already computed - isSettlementConsistent
  // below still re-derives and checks it, not just trusts this default.
  return { ...value, settlement: { ...value.settlement, forcedByTimeout: false } };
}

function withDefaultedSettlementFailureCount(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (value.settlementFailureCount !== undefined) {
    return value;
  }

  // F-07's settlementFailureCount did not exist when a version-2 "settling"
  // envelope was written, so this episode cannot have inherited any prior
  // failed-settlement count for its round - 0 reproduces exactly that
  // absence of history rather than guessing at some other starting point.
  // isSettlementFailureCount's [0, SETTLEMENT_FAILURE_EPISODE_CAP) range
  // check still runs on the migrated record below, and 0 is always inside
  // it regardless of where the cap itself is set.
  return { ...value, settlementFailureCount: 0 };
}

function withDefaultedLockedSettlementFailureCount(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (value.settlementFailureCount !== undefined || value.lockedPendingTrade === undefined) {
    return value;
  }

  // Mirrors withDefaultedSettlementFailureCount, but only when this
  // choosingSide is actually locked (lockedPendingTrade present) - a
  // version-2 "choosingSide" already had F-06's lockedPendingTrade field,
  // but F-07's settlementFailureCount pairs 1:1 with it (see
  // ChoosingSideGameState's doc comment: both set together by
  // SETTLEMENT_FAILED, both absent on a plain SUBMIT_MARKET_QUOTE
  // choosingSide). Defaulting settlementFailureCount here unconditionally -
  // rather than only when lockedPendingTrade is also present - would
  // manufacture an illegal half-set state on every ordinary, never-bounced
  // choosingSide instead of preserving both-absent.
  return { ...value, settlementFailureCount: 0 };
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
    isFiniteNumber(value.marketMakerPnL) &&
    typeof value.forcedByTimeout === "boolean";
}

function isRoundForfeit(value: unknown): value is RoundForfeit {
  return isRecord(value) &&
    isPositiveInteger(value.roundNumber) &&
    typeof value.itemTitle === "string" &&
    isGamePhase(value.phase) &&
    isPlayerId(value.forfeitedBy) &&
    isPlayerId(value.awardedTo) &&
    value.forfeitedBy !== value.awardedTo &&
    isFiniteNumber(value.penalty);
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
    forcedByTimeout: settlement.forcedByTimeout,
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
    left.marketMakerPnL === right.marketMakerPnL &&
    left.forcedByTimeout === right.forcedByTimeout;
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
      value === "roundForfeited" ||
      value === "gameOver" ||
      value === "error"
    );
}

function isTradeSide(value: unknown): value is TradeSide {
  return value === "BUY" || value === "SELL";
}

/**
 * F-06: mirrors PendingTradeDecision's two variants exactly - a "chosen"
 * trade requires a validated TradeSide and nothing else, while
 * "timeoutForcedWorstSide" carries no extra fields (the actual side is
 * resolved later - see resolvePendingTradeSide - so persisting one here
 * would be recomputable-but-stale data, not a fact about the pending
 * decision). hasOnlyKeys on both branches keeps an illegal blend (e.g. a
 * "timeoutForcedWorstSide" that also carries a stray `side`) unrepresentable.
 */
function isPendingTradeDecision(value: unknown): value is PendingTradeDecision {
  if (!isRecord(value)) {
    return false;
  }

  if (value.kind === "chosen") {
    return hasOnlyKeys(value, ["kind", "side"]) && isTradeSide(value.side);
  }

  return value.kind === "timeoutForcedWorstSide" && hasOnlyKeys(value, ["kind"]);
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

/**
 * F-07: valid range is [0, SETTLEMENT_FAILURE_EPISODE_CAP) - a persisted
 * `settling` or locked `choosingSide` can only ever have already failed
 * *fewer* times than the cap, since reaching the cap routes to the
 * terminal `error` phase instead of persisting another settling/choosingSide
 * state at all (see the SETTLEMENT_FAILED case in reducer.ts). Rejecting an
 * out-of-range value here - rather than only trusting the reducer to never
 * produce one - keeps a corrupted or tampered envelope from smuggling in a
 * round that looks like it is one bounce further along than any reducer
 * transition could actually produce.
 */
function isSettlementFailureCount(value: unknown): value is number {
  return isNonNegativeInteger(value) && value < SETTLEMENT_FAILURE_EPISODE_CAP;
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
