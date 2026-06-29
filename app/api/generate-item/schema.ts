import {
  GAME_MODES,
  validateProviderItem,
  type GameMode,
  type ProviderGeneratedItem,
} from "../../../src/lib/game";

const DEFAULT_MODE: GameMode = "Chaos Quant";
const ITEM_KEYS = new Set([
  "item_title",
  "category",
  "context_clue",
  "true_value"
]);

export function normalizeMode(value: unknown): GameMode {
  if (typeof value !== "string") {
    return DEFAULT_MODE;
  }

  const normalized = value.trim().toLowerCase();
  return (
    GAME_MODES.find((mode) => mode.toLowerCase() === normalized) ??
    DEFAULT_MODE
  );
}

export function parseGenerateItemBody(body: unknown): { mode: GameMode } {
  if (!isRecord(body)) {
    return { mode: DEFAULT_MODE };
  }

  return { mode: normalizeMode(body.mode) };
}

export function parseProviderItem(text: string | undefined): ProviderGeneratedItem | null {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  const value = parseJsonObject(text);
  return validateGeneratedItem(value);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function validateGeneratedItem(value: unknown): ProviderGeneratedItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const keys = Object.keys(value);
  if (keys.length !== ITEM_KEYS.size || keys.some((key) => !ITEM_KEYS.has(key))) {
    return null;
  }

  const itemTitle = readNonEmptyString(value.item_title);
  const category = readNonEmptyString(value.category);
  const contextClue = readNonEmptyString(value.context_clue);
  const trueValue = value.true_value;

  if (
    itemTitle === null ||
    category === null ||
    contextClue === null ||
    typeof trueValue !== "number" ||
    !Number.isFinite(trueValue)
  ) {
    return null;
  }

  const item = {
    item_title: itemTitle,
    category,
    context_clue: contextClue,
    true_value: trueValue
  };

  return validateProviderItem(item).ok ? item : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
