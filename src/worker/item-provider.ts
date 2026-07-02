import { GoogleGenAI } from "@google/genai/web";

import marketConfig from "../../config/gemini-markets.json";
import {
  createCustomAmazonItemProvider,
  createFakeAmazonLookup,
  createFetchAmazonLookup,
  withAmazonPriceLookup,
} from "../api/item-generation/amazon-provider";
import {
  buildGeminiPrompt,
  GEMINI_MODEL,
  GEMINI_RESPONSE_MIME_TYPE,
  GEMINI_RESPONSE_SCHEMA,
} from "../api/item-generation/config";
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
import type { GameMode } from "../lib/game";

const DETERMINISTIC_PROVIDER_MODE = "deterministic";
const MISSING_API_KEY_MESSAGE = "Item generation is not configured.";
const INVALID_PROVIDER_ITEM_MESSAGE = "Item provider returned an invalid item.";
const PROVIDER_FAILED_MESSAGE = "Item provider could not generate an item.";

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
        contents: buildGeminiPrompt({ marketConfig, mode }),
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
