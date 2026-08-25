import { describe, expect, it } from "vitest";

import {
  itemForRound,
  maxRoundsForDeck,
  validateStaticDeck
} from "./static-deck";
import { GAME_MODES, MAX_PLAYABLE_ABSOLUTE_VALUE } from "../lib/game";
import type { DeckItem } from "./static-deck";

const REQUIRED_DECK_ITEM_KEYS = [
  "item_title",
  "category",
  "context_clue",
  "true_value",
] as const;

describe("static deck", () => {
  it("validates at import: every GAME_MODES member maps to a non-empty array of four-key items in bounds", () => {
    // A throw during module init would have failed this file's collection;
    // assert the contract explicitly so a silent no-op cannot pass.
    expect(() => validateStaticDeck()).not.toThrow();
  });

  it("scopes validation to GAME_MODES members (extra deck sections are inert)", () => {
    for (const mode of GAME_MODES) {
      const items = itemForRoundAll(mode);

      expect(items.length).toBeGreaterThan(0);

      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([...REQUIRED_DECK_ITEM_KEYS].sort());
        expect(Number.isFinite(item.true_value)).toBe(true);
        expect(Math.abs(item.true_value)).toBeLessThanOrEqual(MAX_PLAYABLE_ABSOLUTE_VALUE);
      }
    }
  });

  it("picks round N via plain modulo over the mode's deck (D3)", () => {
    const first = itemForRound("Chaos Quant", 1);
    const second = itemForRound("Chaos Quant", 2);
    const eleventh = itemForRound("Chaos Quant", 11);

    // Deterministic and recomputable - the same call always returns the same
    // item, which is what lets Phase 3 recompute settlement from the deck.
    expect(itemForRound("Chaos Quant", 1)).toEqual(first);
    expect(second).not.toEqual(first);
    // (roundNumber - 1) % len wraps: round 11 repeats round 1.
    expect(eleventh).toEqual(first);
  });

  it("caps totalRounds at the smallest per-mode deck length so a match never repeats an item", () => {
    const minDeckLength = Math.min(
      ...GAME_MODES.map((mode) => itemForRoundAll(mode).length)
    );

    expect(maxRoundsForDeck()).toBe(minDeckLength);
    expect(maxRoundsForDeck()).toBeGreaterThanOrEqual(1);
  });
});

function itemForRoundAll(mode: (typeof GAME_MODES)[number]): DeckItem[] {
  const items: DeckItem[] = [];

  for (let round = 1; round <= maxRoundsForDeck(); round += 1) {
    items.push(itemForRound(mode, round));
  }

  return items;
}
