import { GoogleGenAI } from "@google/genai";
import type { GameMode } from "../../lib/game";
import {
  buildGeminiPrompt,
  GEMINI_MODEL,
  GEMINI_RESPONSE_MIME_TYPE,
  GEMINI_RESPONSE_SCHEMA,
  type GeminiMarketConfig,
} from "./config";
import { parseProviderItemJson } from "./provider-json";
import type {
  GenerateItemProvider,
  ItemGenerationErrorCode,
  ItemGenerationResult,
} from "./types";

const MISSING_API_KEY_MESSAGE = "Item generation is not configured.";
const INVALID_PROVIDER_ITEM_MESSAGE = "Item provider returned an invalid item.";
const PROVIDER_FAILED_MESSAGE = "Item provider could not generate an item.";

export type GeminiTextGenerationRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly responseMimeType: string;
  readonly responseSchema: unknown;
};

export type GeminiTextGenerator = (
  request: GeminiTextGenerationRequest,
) => Promise<string | undefined>;

export type GeminiTextGeneratorFactory = (
  apiKey: string,
) => GeminiTextGenerator;

export type GeminiItemProviderOptions = {
  readonly apiKey: string | undefined;
  readonly createTextGenerator: GeminiTextGeneratorFactory;
  readonly marketConfig: GeminiMarketConfig | null;
};

export function createGoogleGeminiTextGenerator(
  apiKey: string,
): GeminiTextGenerator {
  const ai = new GoogleGenAI({ apiKey });

  return async ({
    model,
    prompt,
    responseMimeType,
    responseSchema,
  }: GeminiTextGenerationRequest): Promise<string | undefined> => {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType,
        responseSchema,
      },
    });

    return response.text;
  };
}

export function createGeminiItemProvider({
  apiKey,
  createTextGenerator,
  marketConfig,
}: GeminiItemProviderOptions): GenerateItemProvider {
  return async ({ mode }: { readonly mode: GameMode }): Promise<ItemGenerationResult> => {
    if (!apiKey) {
      return failure("missing_api_key", MISSING_API_KEY_MESSAGE);
    }

    try {
      const generateText = createTextGenerator(apiKey);
      const text = await generateText({
        model: GEMINI_MODEL,
        prompt: buildGeminiPrompt({ marketConfig, mode }),
        responseMimeType: GEMINI_RESPONSE_MIME_TYPE,
        responseSchema: GEMINI_RESPONSE_SCHEMA,
      });
      const item = parseProviderItemJson(text);

      if (item === null) {
        return failure("invalid_provider_response", INVALID_PROVIDER_ITEM_MESSAGE);
      }

      return { ok: true, item };
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
