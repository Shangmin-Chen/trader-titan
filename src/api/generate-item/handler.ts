import { NextResponse, type NextRequest } from "next/server";
import marketConfig from "../../../config/gemini-markets.json";
import type { GeneratedItem, ProviderGeneratedItem } from "../../lib/game";
import {
  createItemGenerationRateLimiter,
  isAllowedOrigin,
  readRequestJson,
  type RequestPredicate,
} from "../request-guards";
import {
  createFakeAmazonLookup,
  createFetchAmazonLookup,
  createGeminiItemProvider,
  createGoogleGeminiTextGenerator,
  withAmazonPriceLookup,
  type GenerateItemProvider,
  type ItemGenerationError,
} from "../item-generation";
import { storeGeneratedRound } from "../round-store";
import { parseGenerateItemBody } from "./schema";

export const runtime = "nodejs";

type GenerateItemRuntimeEnv = {
  readonly geminiApiKey: string | undefined;
  readonly isTestEnvironment: boolean;
};

type StoreGeneratedRound = (item: ProviderGeneratedItem) => GeneratedItem;

type GenerateItemPostHandlerOptions = {
  readonly createProvider: (env: GenerateItemRuntimeEnv) => GenerateItemProvider;
  readonly readRuntimeEnv: () => GenerateItemRuntimeEnv;
  readonly storeRound: StoreGeneratedRound;
  readonly isOriginAllowed?: RequestPredicate;
  readonly rateLimiter?: RequestPredicate;
};

export function createGenerateItemPostHandler({
  createProvider,
  readRuntimeEnv,
  storeRound,
  isOriginAllowed = isAllowedOrigin,
  rateLimiter = defaultRateLimiter,
}: GenerateItemPostHandlerOptions): (request: NextRequest) => Promise<Response> {
  return async function generateItemPostHandler(
    request: NextRequest,
  ): Promise<Response> {
    if (!isOriginAllowed(request)) {
      return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
    }

    if (!rateLimiter(request)) {
      return NextResponse.json(
        { error: "Item generation rate limit exceeded." },
        { status: 429 },
      );
    }

    const { mode } = parseGenerateItemBody(await readRequestJson(request));
    const provider = createProvider(readRuntimeEnv());

    try {
      const result = await provider({ mode });
      if (!result.ok) {
        return generationErrorResponse(result.error);
      }

      return NextResponse.json(storeRound(result.item));
    } catch (error) {
      console.error("Item provider error:", error);
      return NextResponse.json(
        { error: "Item provider could not generate an item." },
        { status: 502 },
      );
    }
  };
}

const defaultRateLimiter = createItemGenerationRateLimiter();

export const POST = createGenerateItemPostHandler({
  createProvider: createLegacyGenerateItemProvider,
  readRuntimeEnv,
  storeRound: storeGeneratedRound,
});

function createLegacyGenerateItemProvider({
  geminiApiKey,
  isTestEnvironment,
}: GenerateItemRuntimeEnv): GenerateItemProvider {
  const geminiProvider = createGeminiItemProvider({
    apiKey: geminiApiKey,
    createTextGenerator: createGoogleGeminiTextGenerator,
    marketConfig,
  });
  const amazonLookup = isTestEnvironment
    ? createFakeAmazonLookup()
    : createFetchAmazonLookup({ fetchImpl: (input, init) => fetch(input, init) });

  return withAmazonPriceLookup({
    amazonLookup,
    generateItem: geminiProvider,
  });
}

function readRuntimeEnv(): GenerateItemRuntimeEnv {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY,
    isTestEnvironment: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  };
}

function generationErrorResponse(error: ItemGenerationError): Response {
  if (error.code === "missing_api_key") {
    return NextResponse.json(
      { error: "Item generation is not configured." },
      { status: 500 },
    );
  }

  if (error.code === "invalid_provider_response") {
    return NextResponse.json(
      { error: "Item provider returned an invalid item." },
      { status: 502 },
    );
  }

  if (error.code === "amazon_price_unavailable") {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  if (error.code === "provider_failed") {
    console.error("Item provider error:", error.cause ?? error.message);
  }

  return NextResponse.json(
    { error: "Item provider could not generate an item." },
    { status: 502 },
  );
}
