import { GoogleGenAI, Type } from "@google/genai/web";

import {
  createCustomAmazonItemProvider,
  createFakeAmazonLookup,
  createFetchAmazonLookup,
  withAmazonPriceLookup,
} from "../api/item-generation/amazon-provider";
import { parseProviderItemJson } from "../api/item-generation/provider-json";
import { createDeterministicItemProvider } from "../api/item-generation/test-provider";
import type {
  FetchLike,
  GenerateCustomAmazonItemProvider,
  GenerateItemProvider,
  ItemGenerationError,
  ItemGenerationErrorCode,
  ItemGenerationResult,
} from "../api/item-generation/types";
import {
  MAX_PLAYABLE_ABSOLUTE_VALUE,
  type GameMode,
} from "../lib/game";

const DETERMINISTIC_PROVIDER_MODE = "deterministic";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_RESPONSE_MIME_TYPE = "application/json";
const DEFAULT_SYSTEM_INSTRUCTIONS = "Generate one numeric game item for Titan Trader.";
const MISSING_API_KEY_MESSAGE = "Item generation is not configured.";
const INVALID_PROVIDER_ITEM_MESSAGE = "Item provider returned an invalid item.";
const PROVIDER_FAILED_MESSAGE = "Item provider could not generate an item.";

const DEFAULT_MODE_GUIDANCE: Record<GameMode, string> = {
  Amazon:
    "Generate a popular, widely-known physical product sold on Amazon. Choose an item that has a stable, common price range and return 0 for true_value because the Worker will replace it with a lookup price.",
  "Chaos Quant":
    "make a surprising static quantitative item from math, fixed rules, durable objects, or timeless facts.",
  "Cosmic Scale":
    "use a stable astronomical or physical scale, distance, mass, count, duration, or ratio based on canonical constants or long-settled facts.",
  "Fermi Math & Geometry":
    "create a static estimation, math, or geometry quantity with enough fixed dimensions or assumptions in the clue to compute the answer.",
  "Static Landmarks & History":
    "use a static, absolute landmark or historical metric, date, distance, height, count, or duration that does not depend on current events.",
};

const GEMINI_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    item_title: {
      type: Type.STRING,
      description: "Short display title for the generated numeric item.",
    },
    category: {
      type: Type.STRING,
      description: "The requested generation mode or a concise subcategory.",
    },
    context_clue: {
      type: Type.STRING,
      description:
        "One compact clue that gives enough static context for a player to reason about the quantity.",
    },
    true_value: {
      type: Type.NUMBER,
      description:
        "The exact numeric answer as a JSON number only, with no commas, units, symbols, or formatting.",
    },
  },
  required: ["item_title", "category", "context_clue", "true_value"],
  propertyOrdering: ["item_title", "category", "context_clue", "true_value"],
} as const;

export type WorkerItemProviderMode =
  | typeof DETERMINISTIC_PROVIDER_MODE
  | "gemini";

export type WorkerRoomItemProviderEnv = Readonly<{
  GEMINI_API_KEY?: string;
  WORKER_ITEM_PROVIDER?: WorkerItemProviderMode;
}>;

export type WorkerRoomItemProviderOptions = Readonly<{
  env: WorkerRoomItemProviderEnv;
  fetchImpl: FetchLike;
}>;

export type WorkerRoomItemProviders = Readonly<{
  generateItem: GenerateItemProvider;
  generateCustomAmazonItem: GenerateCustomAmazonItemProvider;
}>;

export function createWorkerRoomItemProviders({
  env,
  fetchImpl,
}: WorkerRoomItemProviderOptions): WorkerRoomItemProviders {
  if (env.WORKER_ITEM_PROVIDER === DETERMINISTIC_PROVIDER_MODE) {
    const amazonLookup = createFakeAmazonLookup();

    return {
      generateItem: withAmazonPriceLookup({
        amazonLookup,
        generateItem: createDeterministicItemProvider(),
      }),
      generateCustomAmazonItem: createCustomAmazonItemProvider({ amazonLookup }),
    };
  }

  const amazonLookup = createFetchAmazonLookup({ fetchImpl });

  return {
    generateItem: withAmazonPriceLookup({
      amazonLookup,
      generateItem: createWorkerGeminiItemProvider(env.GEMINI_API_KEY),
    }),
    generateCustomAmazonItem: createCustomAmazonItemProvider({ amazonLookup }),
  };
}

export function itemGenerationErrorMessage(error: ItemGenerationError): string {
  switch (error.code) {
    case "amazon_price_unavailable":
    case "invalid_custom_query":
      return error.message;
    case "invalid_provider_response":
      return INVALID_PROVIDER_ITEM_MESSAGE;
    case "missing_api_key":
      return MISSING_API_KEY_MESSAGE;
    case "provider_failed":
      return PROVIDER_FAILED_MESSAGE;
    default:
      return assertNever(error.code);
  }
}

function createWorkerGeminiItemProvider(
  apiKey: string | undefined,
): GenerateItemProvider {
  return async ({ mode }: { readonly mode: GameMode }): Promise<ItemGenerationResult> => {
    if (!apiKey) {
      return failure("missing_api_key", MISSING_API_KEY_MESSAGE);
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: buildGeminiPrompt(mode),
        config: {
          responseMimeType: GEMINI_RESPONSE_MIME_TYPE,
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      });
      const item = parseProviderItemJson(response.text);

      return item === null
        ? failure("invalid_provider_response", INVALID_PROVIDER_ITEM_MESSAGE)
        : { ok: true, item };
    } catch (error) {
      return failure("provider_failed", PROVIDER_FAILED_MESSAGE, error);
    }
  };
}

function buildGeminiPrompt(mode: GameMode): string {
  return `${DEFAULT_SYSTEM_INSTRUCTIONS}

Requested mode: ${mode}

Guidance for this mode:
- ${mode}: ${DEFAULT_MODE_GUIDANCE[mode]}

Hard requirements:
- Return exactly one JSON object and no surrounding prose.
- Match this exact shape: {"item_title": string, "category": string, "context_clue": string, "true_value": number}.
- true_value must be a JSON number only: no commas, units, symbols, percentages, fractions, exponent notation as a string, or formatting.
- true_value must be within +/-${MAX_PLAYABLE_ABSOLUTE_VALUE} so the game can settle with reliable numeric precision.
- Use only static, absolute quantitative metrics, problems, or facts that require zero live web lookups.
- Do not use search, grounding, browsing, current data, latest records, prices, weather, market values, live populations, active rankings, or any fact likely to change over time.
- If a fact could plausibly have changed after publication, choose a different static item.
- Make the clue self-contained, concise, and playable without revealing the numeric answer.`;
}

function failure(
  code: ItemGenerationErrorCode,
  message: string,
  cause?: unknown,
): ItemGenerationResult {
  return {
    ok: false,
    error: {
      code,
      message,
      cause,
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Worker item generation error: ${String(value)}`);
}
