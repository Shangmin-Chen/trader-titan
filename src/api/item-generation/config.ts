import { MAX_PLAYABLE_ABSOLUTE_VALUE, type GameMode } from "../../lib/game";

export const GEMINI_MODEL = "gemini-2.5-flash";
export const GEMINI_RESPONSE_MIME_TYPE = "application/json";

const DEFAULT_SYSTEM_INSTRUCTIONS = "Generate one numeric game item for Titan Trader.";

const DEFAULT_MODE_GUIDANCE: Record<GameMode, string> = {
  Amazon:
    "Generate a popular, widely-known physical product sold on Amazon. Examples: 'Apple iPad Air', 'Sony PlayStation 5', 'Nintendo Switch'. Choose items that have a relatively stable and well-known price range. Do NOT return the actual price, just return a dummy value of 0 for true_value.",
  "Chaos Quant":
    "make a surprising static quantitative item from math, fixed rules, durable objects, or timeless facts.",
  "Cosmic Scale":
    "use a stable astronomical or physical scale, distance, mass, count, duration, or ratio based on canonical constants or long-settled facts.",
  "Fermi Math & Geometry":
    "create a static estimation, math, or geometry quantity with enough fixed dimensions or assumptions in the clue to compute the answer.",
  "Static Landmarks & History":
    "use a static, absolute landmark or historical metric, date, distance, height, count, or duration that does not depend on current events.",
};

export type GeminiMarketConfig = {
  readonly systemInstructions?: string;
  readonly modeGuidance?: Partial<Record<GameMode, string>>;
};

export type GeminiPromptInput = {
  readonly marketConfig: GeminiMarketConfig | null;
  readonly mode: GameMode;
};

export const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    item_title: {
      type: "STRING",
      description: "Short display title for the generated numeric item.",
    },
    category: {
      type: "STRING",
      description: "The requested generation mode or a concise subcategory.",
    },
    context_clue: {
      type: "STRING",
      description:
        "One compact clue that gives enough static context for a player to reason about the quantity.",
    },
    true_value: {
      type: "NUMBER",
      description:
        "The exact numeric answer as a JSON number only, with no commas, units, symbols, or formatting.",
    },
  },
  required: ["item_title", "category", "context_clue", "true_value"],
  propertyOrdering: ["item_title", "category", "context_clue", "true_value"],
} as const;

export function buildGeminiPrompt({
  marketConfig,
  mode,
}: GeminiPromptInput): string {
  const systemInstructions =
    marketConfig?.systemInstructions ?? DEFAULT_SYSTEM_INSTRUCTIONS;
  const modeGuidance =
    marketConfig?.modeGuidance?.[mode] ?? DEFAULT_MODE_GUIDANCE[mode];

  return `${systemInstructions}

Requested mode: ${mode}

Guidance for this mode:
- ${mode}: ${modeGuidance}

Hard requirements:
- Return exactly one JSON object and no surrounding prose.
- Match this exact shape: {"item_title": string, "category": string, "context_clue": string, "true_value": number}.
- true_value must be a JSON number only: no commas, symbols, units, percentages, fractions, exponent notation as a string, or formatting.
- true_value must be within +/-${MAX_PLAYABLE_ABSOLUTE_VALUE} so the game can settle with reliable numeric precision.
- Use only static, absolute quantitative metrics, problems, or facts that require zero live web lookups.
- Do not use search, grounding, browsing, current data, "latest" records, prices, weather, market values, live populations, active rankings, or any fact likely to change over time.
- If a fact could plausibly have changed after publication, choose a different static item.
- Make the clue self-contained, concise, and playable without revealing the numeric answer.`;
}

export const GEMINI_BATCH_RESPONSE_SCHEMA = {
  type: "ARRAY",
  description: "A list of unique quantitative items generated for the game.",
  items: {
    type: "OBJECT",
    properties: {
      item_title: {
        type: "STRING",
        description: "Short display title for the generated numeric item.",
      },
      category: {
        type: "STRING",
        description: "The requested generation mode or a concise subcategory.",
      },
      context_clue: {
        type: "STRING",
        description:
          "One compact clue that gives enough static context for a player to reason about the quantity.",
      },
      true_value: {
        type: "NUMBER",
        description:
          "The exact numeric answer as a JSON number only, with no commas, units, symbols, or formatting.",
      },
    },
    required: ["item_title", "category", "context_clue", "true_value"],
    propertyOrdering: ["item_title", "category", "context_clue", "true_value"],
  },
} as const;

export function buildGeminiBatchPrompt({
  marketConfig,
  mode,
  count,
}: {
  marketConfig: GeminiMarketConfig | null;
  mode: GameMode;
  count: number;
}): string {
  const systemInstructions =
    marketConfig?.systemInstructions ?? DEFAULT_SYSTEM_INSTRUCTIONS;
  const modeGuidance =
    marketConfig?.modeGuidance?.[mode] ?? DEFAULT_MODE_GUIDANCE[mode];

  return `${systemInstructions}

Requested mode: ${mode}
Number of items required: ${count}

Guidance for this mode:
- ${mode}: ${modeGuidance}

Hard requirements:
- Return a JSON array containing exactly ${count} unique items, with no surrounding prose.
- Each item must match this exact shape: {"item_title": string, "category": string, "context_clue": string, "true_value": number}.
- For each item, true_value must be a JSON number only: no commas, symbols, units, percentages, fractions, exponent notation as a string, or formatting.
- For each item, true_value must be within +/-${MAX_PLAYABLE_ABSOLUTE_VALUE} so the game can settle with reliable numeric precision.
- Use only static, absolute quantitative metrics, problems, or facts that require zero live web lookups.
- Do not use search, grounding, browsing, current data, "latest" records, prices, weather, market values, live populations, active rankings, or any fact likely to change over time.
- If a fact could plausibly have changed after publication, choose a different static item.
- Make the clue self-contained, concise, and playable without revealing the numeric answer.
- Ensure all ${count} items are completely unique and distinct from one another.`;
}
