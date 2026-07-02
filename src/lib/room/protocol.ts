import {
  GAME_MODES,
  MAX_ROUNDS,
  type GameMode,
  type GeneratedItem,
  type Quote,
  type ScrapedAmazonItem,
  type SettledGeneratedItem,
  type TradeSide,
} from "../game/types";
import {
  validateProviderItem,
  validateQuote,
  validateSpreadWidth,
  validateTradeSide,
} from "../game/validation";
import {
  parseCapabilityToken,
  parseTokenHash,
  type PresentedCapabilityToken,
  type TokenHash,
} from "./tokens";
import type { RoomGameConfig, UnixTimeMs } from "./types";

const CONFIG_KEYS = ["mode", "totalRounds", "customAmazonQuery"] as const;
const GENERATED_ITEM_KEYS = [
  "round_id",
  "item_title",
  "category",
  "context_clue",
] as const;
const QUOTE_KEYS = ["bid", "ask"] as const;
const SCRAPED_ITEM_KEYS = ["title", "price"] as const;
const SETTLED_ITEM_KEYS = [
  ...GENERATED_ITEM_KEYS,
  "true_value",
  "scraped_items",
  "amazon_url",
] as const;

export type HostRoomCommandType =
  | "CONFIGURE_ROOM"
  | "START_ROOM"
  | "RESET_TO_LOBBY"
  | "KICK_GUEST"
  | "ADVANCE_ROUND"
  | "RETRY_ITEM_GENERATION";

export type PlayerRoomCommandType =
  | "SUBMIT_INITIAL_WIDTH"
  | "TIGHTEN_WIDTH"
  | "TRADE_ON_WIDTH"
  | "SUBMIT_MARKET_QUOTE"
  | "EXECUTE_TRADE";

export type JoinRoomCommand = Readonly<{
  type: "JOIN_ROOM";
  guestTokenHash: TokenHash;
  guestName: string;
  nowMs: UnixTimeMs;
}>;

export type HostRoomCommand =
  | Readonly<{
      type: "CONFIGURE_ROOM";
      credential: PresentedCapabilityToken;
      config: Partial<RoomGameConfig>;
      nowMs: UnixTimeMs;
    }>
  | Readonly<{
      type:
        | "START_ROOM"
        | "RESET_TO_LOBBY"
        | "KICK_GUEST"
        | "ADVANCE_ROUND"
        | "RETRY_ITEM_GENERATION";
      credential: PresentedCapabilityToken;
      nowMs: UnixTimeMs;
    }>;

export type PlayerRoomCommand =
  | Readonly<{
      type: "SUBMIT_INITIAL_WIDTH" | "TIGHTEN_WIDTH";
      credential: PresentedCapabilityToken;
      width: number;
      nowMs: UnixTimeMs;
    }>
  | Readonly<{
      type: "TRADE_ON_WIDTH";
      credential: PresentedCapabilityToken;
      nowMs: UnixTimeMs;
    }>
  | Readonly<{
      type: "SUBMIT_MARKET_QUOTE";
      credential: PresentedCapabilityToken;
      quote: Quote;
      nowMs: UnixTimeMs;
    }>
  | Readonly<{
      type: "EXECUTE_TRADE";
      credential: PresentedCapabilityToken;
      side: TradeSide;
      nowMs: UnixTimeMs;
    }>;

export type SystemRoomEvent =
  | Readonly<{
      type: "ITEM_RECEIVED";
      item: GeneratedItem;
      nowMs: UnixTimeMs;
    }>
  | Readonly<{
      type: "ITEM_FAILED";
      error: string;
      nowMs: UnixTimeMs;
    }>
  | Readonly<{
      type: "SETTLEMENT_RECEIVED";
      item: SettledGeneratedItem;
      nowMs: UnixTimeMs;
    }>
  | Readonly<{
      type: "SETTLEMENT_FAILED";
      error: string;
      nowMs: UnixTimeMs;
    }>;

export type ClientRoomCommand =
  | JoinRoomCommand
  | HostRoomCommand
  | PlayerRoomCommand;

export type RoomProtocolDecodeErrorCode =
  | "message_not_object"
  | "message_type_invalid"
  | "message_type_unknown"
  | "now_invalid"
  | "credential_invalid"
  | "guest_name_invalid"
  | "guest_token_hash_invalid"
  | "config_invalid"
  | "width_invalid"
  | "quote_invalid"
  | "trade_side_invalid"
  | "item_invalid"
  | "error_invalid"
  | "settlement_not_allowed";

export type RoomProtocolDecodeError = Readonly<{
  code: RoomProtocolDecodeErrorCode;
  message: string;
  path: string;
}>;

export type ClientRoomCommandDecodeResult =
  | Readonly<{ ok: true; command: ClientRoomCommand }>
  | Readonly<{ ok: false; error: RoomProtocolDecodeError }>;

export type SystemRoomEventDecodeResult =
  | Readonly<{ ok: true; event: SystemRoomEvent }>
  | Readonly<{ ok: false; error: RoomProtocolDecodeError }>;

export type RoomGameConfigPatchDecodeResult =
  | Readonly<{ ok: true; config: Partial<RoomGameConfig> }>
  | Readonly<{ ok: false; error: RoomProtocolDecodeError }>;

type DecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: RoomProtocolDecodeError }>;

type ClientCommandType = ClientRoomCommand["type"];
type MutableRoomGameConfigPatch = {
  mode?: RoomGameConfig["mode"];
  totalRounds?: RoomGameConfig["totalRounds"];
  customAmazonQuery?: NonNullable<RoomGameConfig["customAmazonQuery"]>;
};
type SystemEventType = SystemRoomEvent["type"];

/**
 * Runtime transports pass untrusted JSON, while room commands rely on typed
 * inputs to avoid recording invalid reducer state.
 */
export function parseClientRoomCommand(
  value: unknown,
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const now = decodeNowMs(nowMs);

  if (!now.ok) {
    return decodeCommandFailure(now.error);
  }

  if (!isRecord(value)) {
    return decodeCommandFailure(
      decodeError("message_not_object", "Room command must be an object.", "$"),
    );
  }

  const type = decodeClientCommandType(value.type);

  if (!type.ok) {
    return decodeCommandFailure(type.error);
  }

  switch (type.value) {
    case "JOIN_ROOM":
      return decodeJoinRoomCommand(value, now.value);
    case "CONFIGURE_ROOM":
      return decodeConfigureRoomCommand(value, now.value);
    case "START_ROOM":
    case "RESET_TO_LOBBY":
    case "KICK_GUEST":
    case "ADVANCE_ROUND":
    case "RETRY_ITEM_GENERATION":
      return decodeHostRoomCommand(value, type.value, now.value);
    case "SUBMIT_INITIAL_WIDTH":
    case "TIGHTEN_WIDTH":
      return decodeWidthRoomCommand(value, type.value, now.value);
    case "TRADE_ON_WIDTH":
      return decodeTradeOnWidthCommand(value, now.value);
    case "SUBMIT_MARKET_QUOTE":
      return decodeSubmitMarketQuoteCommand(value, now.value);
    case "EXECUTE_TRADE":
      return decodeExecuteTradeCommand(value, now.value);
    default:
      return assertNever(type.value);
  }
}

export function parseRoomGameConfigPatch(
  value: unknown,
): RoomGameConfigPatchDecodeResult {
  const config = decodeRoomGameConfigPatch(value);

  return config.ok
    ? { ok: true, config: config.value }
    : { ok: false, error: config.error };
}

/**
 * System event decoding is separate from client command decoding because these
 * messages come from trusted server-side effects and may include private values.
 */
export function parseSystemRoomEvent(
  value: unknown,
  nowMs: UnixTimeMs,
): SystemRoomEventDecodeResult {
  const now = decodeNowMs(nowMs);

  if (!now.ok) {
    return decodeEventFailure(now.error);
  }

  if (!isRecord(value)) {
    return decodeEventFailure(
      decodeError("message_not_object", "Room system event must be an object.", "$"),
    );
  }

  const type = decodeSystemEventType(value.type);

  if (!type.ok) {
    return decodeEventFailure(type.error);
  }

  switch (type.value) {
    case "ITEM_RECEIVED": {
      const item = decodeGeneratedItem(value.item, "item");

      return item.ok
        ? { ok: true, event: { type: type.value, item: item.value, nowMs: now.value } }
        : decodeEventFailure(item.error);
    }
    case "ITEM_FAILED": {
      const error = decodeErrorMessage(value.error, "error");

      return error.ok
        ? { ok: true, event: { type: type.value, error: error.value, nowMs: now.value } }
        : decodeEventFailure(error.error);
    }
    case "SETTLEMENT_RECEIVED": {
      if (hasField(value, "settlement")) {
        return decodeEventFailure(
          decodeError(
            "settlement_not_allowed",
            "Settlement is computed by the room command layer and cannot be supplied by callers.",
            "settlement",
          ),
        );
      }

      const item = decodeSettledGeneratedItem(value.item, "item");

      return item.ok
        ? { ok: true, event: { type: type.value, item: item.value, nowMs: now.value } }
        : decodeEventFailure(item.error);
    }
    case "SETTLEMENT_FAILED": {
      const error = decodeErrorMessage(value.error, "error");

      return error.ok
        ? { ok: true, event: { type: type.value, error: error.value, nowMs: now.value } }
        : decodeEventFailure(error.error);
    }
    default:
      return assertNever(type.value);
  }
}

export const decodeClientRoomCommand = parseClientRoomCommand;
export const decodeSystemRoomEvent = parseSystemRoomEvent;

function decodeJoinRoomCommand(
  value: Record<string, unknown>,
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const guestTokenHash = decodeTokenHash(value.guestTokenHash, "guestTokenHash");

  if (!guestTokenHash.ok) {
    return decodeCommandFailure(guestTokenHash.error);
  }

  if (typeof value.guestName !== "string") {
    return decodeCommandFailure(
      decodeError("guest_name_invalid", "Guest name must be a string.", "guestName"),
    );
  }

  return {
    ok: true,
    command: {
      type: "JOIN_ROOM",
      guestTokenHash: guestTokenHash.value,
      guestName: value.guestName,
      nowMs,
    },
  };
}

function decodeConfigureRoomCommand(
  value: Record<string, unknown>,
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const credential = decodePresentedCredential(value.credential);

  if (!credential.ok) {
    return decodeCommandFailure(credential.error);
  }

  const config = decodeRoomGameConfigPatch(value.config);

  if (!config.ok) {
    return decodeCommandFailure(config.error);
  }

  return {
    ok: true,
    command: {
      type: "CONFIGURE_ROOM",
      credential: credential.value,
      config: config.value,
      nowMs,
    },
  };
}

function decodeHostRoomCommand(
  value: Record<string, unknown>,
  type: Exclude<HostRoomCommandType, "CONFIGURE_ROOM">,
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const credential = decodePresentedCredential(value.credential);

  return credential.ok
    ? { ok: true, command: { type, credential: credential.value, nowMs } }
    : decodeCommandFailure(credential.error);
}

function decodeWidthRoomCommand(
  value: Record<string, unknown>,
  type: "SUBMIT_INITIAL_WIDTH" | "TIGHTEN_WIDTH",
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const credential = decodePresentedCredential(value.credential);

  if (!credential.ok) {
    return decodeCommandFailure(credential.error);
  }

  const width = decodeWidth(value.width);

  if (!width.ok) {
    return decodeCommandFailure(width.error);
  }

  return {
    ok: true,
    command: { type, credential: credential.value, width: width.value, nowMs },
  };
}

function decodeTradeOnWidthCommand(
  value: Record<string, unknown>,
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const credential = decodePresentedCredential(value.credential);

  return credential.ok
    ? {
        ok: true,
        command: { type: "TRADE_ON_WIDTH", credential: credential.value, nowMs },
      }
    : decodeCommandFailure(credential.error);
}

function decodeSubmitMarketQuoteCommand(
  value: Record<string, unknown>,
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const credential = decodePresentedCredential(value.credential);

  if (!credential.ok) {
    return decodeCommandFailure(credential.error);
  }

  const quote = decodeQuote(value.quote);

  if (!quote.ok) {
    return decodeCommandFailure(quote.error);
  }

  return {
    ok: true,
    command: {
      type: "SUBMIT_MARKET_QUOTE",
      credential: credential.value,
      quote: quote.value,
      nowMs,
    },
  };
}

function decodeExecuteTradeCommand(
  value: Record<string, unknown>,
  nowMs: UnixTimeMs,
): ClientRoomCommandDecodeResult {
  const credential = decodePresentedCredential(value.credential);

  if (!credential.ok) {
    return decodeCommandFailure(credential.error);
  }

  const side = decodeTradeSide(value.side);

  if (!side.ok) {
    return decodeCommandFailure(side.error);
  }

  return {
    ok: true,
    command: {
      type: "EXECUTE_TRADE",
      credential: credential.value,
      side: side.value,
      nowMs,
    },
  };
}

function decodeClientCommandType(value: unknown): DecodeResult<ClientCommandType> {
  if (typeof value !== "string") {
    return decodeFailure("message_type_invalid", "Room command type must be a string.", "type");
  }

  switch (value) {
    case "JOIN_ROOM":
    case "CONFIGURE_ROOM":
    case "START_ROOM":
    case "RESET_TO_LOBBY":
    case "KICK_GUEST":
    case "ADVANCE_ROUND":
    case "RETRY_ITEM_GENERATION":
    case "SUBMIT_INITIAL_WIDTH":
    case "TIGHTEN_WIDTH":
    case "TRADE_ON_WIDTH":
    case "SUBMIT_MARKET_QUOTE":
    case "EXECUTE_TRADE":
      return { ok: true, value };
    default:
      return decodeFailure("message_type_unknown", "Room command type is not supported.", "type");
  }
}

function decodeSystemEventType(value: unknown): DecodeResult<SystemEventType> {
  if (typeof value !== "string") {
    return decodeFailure("message_type_invalid", "Room system event type must be a string.", "type");
  }

  switch (value) {
    case "ITEM_RECEIVED":
    case "ITEM_FAILED":
    case "SETTLEMENT_RECEIVED":
    case "SETTLEMENT_FAILED":
      return { ok: true, value };
    default:
      return decodeFailure("message_type_unknown", "Room system event type is not supported.", "type");
  }
}

function decodePresentedCredential(value: unknown): DecodeResult<PresentedCapabilityToken> {
  const credential = parseCapabilityToken(value);

  if (!credential.ok) {
    return decodeFailure("credential_invalid", credential.error.message, "credential");
  }

  return {
    ok: true,
    value: {
      roomId: credential.token.roomId,
      role: credential.token.role,
      secret: credential.token.secret,
    },
  };
}

function decodeTokenHash(value: unknown, path: string): DecodeResult<TokenHash> {
  const tokenHash = parseTokenHash(value);

  return tokenHash.ok
    ? { ok: true, value: tokenHash.tokenHash }
    : decodeFailure("guest_token_hash_invalid", tokenHash.error.message, path);
}

function decodeRoomGameConfigPatch(value: unknown): DecodeResult<Partial<RoomGameConfig>> {
  if (!isRecord(value) || !hasOnlyKeys(value, CONFIG_KEYS)) {
    return decodeFailure("config_invalid", "Room config must be an object with supported keys.", "config");
  }

  const config: MutableRoomGameConfigPatch = {};

  if (hasField(value, "mode")) {
    const mode = decodeGameMode(value.mode);

    if (!mode.ok) {
      return mode;
    }

    config.mode = mode.value;
  }

  if (hasField(value, "totalRounds")) {
    if (!isTotalRounds(value.totalRounds)) {
      return decodeFailure(
        "config_invalid",
        `Total rounds must be an integer between 1 and ${MAX_ROUNDS}.`,
        "config.totalRounds",
      );
    }

    config.totalRounds = value.totalRounds;
  }

  if (hasField(value, "customAmazonQuery")) {
    if (typeof value.customAmazonQuery !== "boolean") {
      return decodeFailure(
        "config_invalid",
        "Custom Amazon query must be a boolean.",
        "config.customAmazonQuery",
      );
    }

    config.customAmazonQuery = value.customAmazonQuery;
  }

  return { ok: true, value: config };
}

function decodeGameMode(value: unknown): DecodeResult<GameMode> {
  return typeof value === "string" && GAME_MODES.includes(value as GameMode)
    ? { ok: true, value: value as GameMode }
    : decodeFailure("config_invalid", "Choose a valid game mode.", "config.mode");
}

function decodeWidth(value: unknown): DecodeResult<number> {
  if (typeof value !== "number") {
    return decodeFailure("width_invalid", "Spread width must be a number.", "width");
  }

  const validation = validateSpreadWidth(value);

  return validation.ok
    ? { ok: true, value }
    : decodeFailure("width_invalid", validation.error, "width");
}

function decodeQuote(value: unknown): DecodeResult<Quote> {
  if (!isRecord(value) || !hasOnlyKeys(value, QUOTE_KEYS)) {
    return decodeFailure("quote_invalid", "Quote must contain bid and ask only.", "quote");
  }

  if (typeof value.bid !== "number" || typeof value.ask !== "number") {
    return decodeFailure("quote_invalid", "Quote bid and ask must be numbers.", "quote");
  }

  const quote = { bid: value.bid, ask: value.ask };
  const validation = validateQuote(quote);

  return validation.ok
    ? { ok: true, value: quote }
    : decodeFailure("quote_invalid", validation.error, "quote");
}

function decodeTradeSide(value: unknown): DecodeResult<TradeSide> {
  return validateTradeSide(value)
    ? { ok: true, value }
    : decodeFailure("trade_side_invalid", "Trade side must be BUY or SELL.", "side");
}

function decodeGeneratedItem(
  value: unknown,
  path: string,
): DecodeResult<GeneratedItem> {
  if (!isRecord(value) || !hasOnlyKeys(value, GENERATED_ITEM_KEYS)) {
    return decodeFailure("item_invalid", "Generated item must contain public item fields only.", path);
  }

  return decodeGeneratedItemFields(value, path);
}

function decodeSettledGeneratedItem(
  value: unknown,
  path: string,
): DecodeResult<SettledGeneratedItem> {
  if (!isRecord(value) || !hasOnlyKeys(value, SETTLED_ITEM_KEYS)) {
    return decodeFailure("item_invalid", "Settled item must contain supported settlement fields.", path);
  }

  const publicFields = decodeGeneratedItemFields(value, path);

  if (!publicFields.ok) {
    return publicFields;
  }

  if (typeof value.true_value !== "number") {
    return decodeFailure("item_invalid", "Settled item true value must be a number.", `${path}.true_value`);
  }

  const scrapedItems = hasField(value, "scraped_items")
    ? decodeScrapedItems(value.scraped_items, `${path}.scraped_items`)
    : ({ ok: true, value: undefined } satisfies DecodeResult<ScrapedAmazonItem[] | undefined>);

  if (!scrapedItems.ok) {
    return scrapedItems;
  }

  if (hasField(value, "amazon_url") && typeof value.amazon_url !== "string") {
    return decodeFailure("item_invalid", "Amazon URL must be a string.", `${path}.amazon_url`);
  }

  const item: SettledGeneratedItem = {
    ...publicFields.value,
    true_value: value.true_value,
    ...(scrapedItems.value === undefined ? {} : { scraped_items: scrapedItems.value }),
    ...(typeof value.amazon_url === "string" ? { amazon_url: value.amazon_url } : {}),
  };
  const validation = validateProviderItem(item);

  return validation.ok
    ? { ok: true, value: item }
    : decodeFailure("item_invalid", validation.error, `${path}.true_value`);
}

function decodeGeneratedItemFields(
  value: Record<string, unknown>,
  path: string,
): DecodeResult<GeneratedItem> {
  if (
    typeof value.round_id !== "string" ||
    typeof value.item_title !== "string" ||
    typeof value.category !== "string" ||
    typeof value.context_clue !== "string"
  ) {
    return decodeFailure("item_invalid", "Generated item fields must be strings.", path);
  }

  return {
    ok: true,
    value: {
      round_id: value.round_id,
      item_title: value.item_title,
      category: value.category,
      context_clue: value.context_clue,
    },
  };
}

function decodeScrapedItems(
  value: unknown,
  path: string,
): DecodeResult<ScrapedAmazonItem[]> {
  if (!Array.isArray(value)) {
    return decodeFailure("item_invalid", "Scraped items must be an array.", path);
  }

  const items: ScrapedAmazonItem[] = [];

  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, SCRAPED_ITEM_KEYS) ||
      typeof item.title !== "string" ||
      typeof item.price !== "number" ||
      !Number.isFinite(item.price)
    ) {
      return decodeFailure(
        "item_invalid",
        "Scraped item entries must contain a title string and finite price.",
        `${path}.${index}`,
      );
    }

    items.push({ title: item.title, price: item.price });
  }

  return { ok: true, value: items };
}

function decodeErrorMessage(value: unknown, path: string): DecodeResult<string> {
  return typeof value === "string"
    ? { ok: true, value }
    : decodeFailure("error_invalid", "System error message must be a string.", path);
}

function decodeNowMs(value: unknown): DecodeResult<UnixTimeMs> {
  return isUnixTimeMs(value)
    ? { ok: true, value }
    : decodeFailure("now_invalid", "Runtime timestamp must be a finite non-negative number.", "nowMs");
}

function isTotalRounds(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_ROUNDS;
}

function isUnixTimeMs(value: unknown): value is UnixTimeMs {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function decodeCommandFailure(error: RoomProtocolDecodeError): ClientRoomCommandDecodeResult {
  return { ok: false, error };
}

function decodeEventFailure(error: RoomProtocolDecodeError): SystemRoomEventDecodeResult {
  return { ok: false, error };
}

function decodeFailure(
  code: RoomProtocolDecodeErrorCode,
  message: string,
  path: string,
): DecodeResult<never> {
  return {
    ok: false,
    error: decodeError(code, message, path),
  };
}

function decodeError(
  code: RoomProtocolDecodeErrorCode,
  message: string,
  path: string,
): RoomProtocolDecodeError {
  return {
    code,
    message,
    path,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled room protocol variant: ${String(value)}`);
}
