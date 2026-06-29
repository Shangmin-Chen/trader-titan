import { GAME_MODES, type GameMode } from "../../lib/game";
export { parseProviderItemJson as parseProviderItem } from "../item-generation/provider-json";

const DEFAULT_MODE: GameMode = "Chaos Quant";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
