import {
  GAME_MODES,
  MAX_PLAYABLE_ABSOLUTE_VALUE,
  MAX_ROUNDS,
  type ProviderGeneratedItem,
  type Quote,
  type Roles,
  type StartGamePayload,
  type TradeSide,
  type ValidationResult,
} from "./types";

export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function validateSpreadWidth(width: number): ValidationResult {
  if (!isFiniteNumber(width)) {
    return { ok: false, error: "Spread width must be a finite number." };
  }

  if (width <= 0) {
    return { ok: false, error: "Spread width must be greater than 0." };
  }

  if (width > MAX_PLAYABLE_ABSOLUTE_VALUE) {
    return {
      ok: false,
      error: `Spread width must be within ${MAX_PLAYABLE_ABSOLUTE_VALUE}.`,
    };
  }

  return { ok: true };
}

export function validateTightenedWidth(
  currentWidth: number,
  nextWidth: number,
): ValidationResult {
  const widthValidation = validateSpreadWidth(nextWidth);

  if (!widthValidation.ok) {
    return widthValidation;
  }

  if (nextWidth >= currentWidth) {
    return { ok: false, error: "New spread width must be tighter than current width." };
  }

  return { ok: true };
}

export function validateQuote(quote: Quote): ValidationResult {
  if (!isFiniteNumber(quote.bid) || !isFiniteNumber(quote.ask)) {
    return { ok: false, error: "Quote bid and ask must be finite numbers." };
  }

  if (
    Math.abs(quote.bid) > MAX_PLAYABLE_ABSOLUTE_VALUE ||
    Math.abs(quote.ask) > MAX_PLAYABLE_ABSOLUTE_VALUE
  ) {
    return {
      ok: false,
      error: `Quote values must be within +/-${MAX_PLAYABLE_ABSOLUTE_VALUE}.`,
    };
  }

  if (quote.bid >= quote.ask) {
    return { ok: false, error: "Quote bid must be less than ask." };
  }

  return { ok: true };
}

export function validateQuoteForWidth(quote: Quote, width: number): ValidationResult {
  const quoteValidation = validateQuote(quote);

  if (!quoteValidation.ok) {
    return quoteValidation;
  }

  const widthTolerance = Math.max(
    1e-9,
    Number.EPSILON *
      Math.max(Math.abs(quote.bid), Math.abs(quote.ask), Math.abs(width), 1),
  );

  if (!Number.isFinite(width) || Math.abs(quote.ask - quote.bid - width) > widthTolerance) {
    return { ok: false, error: "Bid and ask must match the accepted spread width." };
  }

  return { ok: true };
}

export function quoteFromAsk(ask: number, width: number): Quote {
  return {
    bid: ask - width,
    ask,
  };
}

export function quoteFromBid(bid: number, width: number): Quote {
  return {
    bid,
    ask: bid + width,
  };
}

export function validateStartGame(payload: StartGamePayload): ValidationResult {
  if (payload.playerAName.trim().length === 0 || payload.playerBName.trim().length === 0) {
    return { ok: false, error: "Both player names are required." };
  }

  if (!GAME_MODES.includes(payload.mode)) {
    return { ok: false, error: "Choose a valid game mode." };
  }

  if (
    !Number.isInteger(payload.totalRounds) ||
    payload.totalRounds < 1 ||
    payload.totalRounds > MAX_ROUNDS
  ) {
    return { ok: false, error: `Number of rounds must be between 1 and ${MAX_ROUNDS}.` };
  }

  return { ok: true };
}

export function validateProviderItem(item: ProviderGeneratedItem): ValidationResult {
  if (!isFiniteNumber(item.true_value)) {
    return { ok: false, error: "True value must be a finite number." };
  }

  if (Math.abs(item.true_value) > MAX_PLAYABLE_ABSOLUTE_VALUE) {
    return {
      ok: false,
      error: `True value must be within +/-${MAX_PLAYABLE_ABSOLUTE_VALUE}.`,
    };
  }

  return { ok: true };
}

export function validateRoles(roles: Roles): ValidationResult {
  if (roles.marketMaker === roles.trader) {
    return { ok: false, error: "Market maker and trader must be different players." };
  }

  return { ok: true };
}

export function validateTradeSide(side: unknown): side is TradeSide {
  return side === "BUY" || side === "SELL";
}

export function parseNumericInput(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
