import deck from "../../config/static-markets.json";
import { GAME_MODES, MAX_PLAYABLE_ABSOLUTE_VALUE } from "../lib/game";
import type { GameMode, ProviderGeneratedItem } from "../lib/game";

export type DeckItem = Omit<ProviderGeneratedItem, "round_id">;

const STATIC_DECK = deck as Record<GameMode, DeckItem[]>;
const REQUIRED_DECK_ITEM_KEYS = [
  "item_title",
  "category",
  "context_clue",
  "true_value",
] as const;

/**
 * D3 (decided): the item for a round is a plain modulo pick behind this
 * single seam. The pick must stay recomputable at settle time, so no
 * randomness and no per-room secret may enter here. Config validation caps
 * totalRounds at maxRoundsForDeck(), so a match can never outlive its item
 * variety and never repeats an item within one match; repetition across
 * matches is an accepted MVP tradeoff.
 */
export function itemForRound(mode: GameMode, roundNumber: number): DeckItem {
  const items = STATIC_DECK[mode];

  return items[(roundNumber - 1) % items.length];
}

/**
 * The tightest round count any mode's deck can support without an in-match
 * repeat. Derived from the loaded deck rather than hardcoded, so adding rows
 * to config/static-markets.json raises the cap automatically.
 */
export function maxRoundsForDeck(): number {
  let min = Number.POSITIVE_INFINITY;

  for (const mode of GAME_MODES) {
    min = Math.min(min, STATIC_DECK[mode].length);
  }

  return min;
}

/**
 * Scoped to GAME_MODES members (D4 decided): extra sections in the deck JSON
 * are inert data, not boot failures.
 */
export function validateStaticDeck(): void {
  for (const mode of GAME_MODES) {
    const items = STATIC_DECK[mode];

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`Static deck has no items for mode ${mode}.`);
    }

    for (const item of items) {
      const keys = Object.keys(item).sort();
      const expectedKeys = [...REQUIRED_DECK_ITEM_KEYS].sort();

      if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error(
          `Static deck item for mode ${mode} must have exactly these keys: ${expectedKeys.join(", ")}.`
        );
      }

      if (
        typeof item.true_value !== "number" ||
        !Number.isFinite(item.true_value) ||
        Math.abs(item.true_value) > MAX_PLAYABLE_ABSOLUTE_VALUE
      ) {
        throw new Error(
          `Static deck item "${item.item_title}" for mode ${mode} has an out-of-range true_value.`
        );
      }
    }
  }
}

validateStaticDeck();
