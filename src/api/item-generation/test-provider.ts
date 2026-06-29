import type { GameMode, ProviderGeneratedItem } from "../../lib/game";
import type { GenerateItemProvider } from "./types";

export const TEST_PROVIDER_ITEM: ProviderGeneratedItem = {
  item_title: "Seconds in an hour",
  category: "Fermi Math & Geometry",
  context_clue: "An hour contains 60 minutes, each with 60 seconds.",
  true_value: 3600,
};

export type DeterministicItemProviderOptions = {
  readonly item?: Partial<ProviderGeneratedItem>;
};

export function createDeterministicItemProvider({
  item,
}: DeterministicItemProviderOptions = {}): GenerateItemProvider {
  return async ({ mode }: { readonly mode: GameMode }) => ({
    ok: true,
    item: {
      ...TEST_PROVIDER_ITEM,
      category: mode,
      ...item,
    },
  });
}

