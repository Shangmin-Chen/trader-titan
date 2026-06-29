import { NextResponse, type NextRequest } from "next/server";
import type { GeneratedItem, ProviderGeneratedItem } from "../lib/game";
import {
  createItemGenerationRateLimiter,
  isAllowedOrigin,
  readRequestJson,
  type RequestPredicate,
} from "./request-guards";
import {
  createCustomAmazonItemProvider,
  createFakeAmazonLookup,
  createFetchAmazonLookup,
  type GenerateCustomAmazonItemProvider,
  type ItemGenerationError,
} from "./item-generation";
import { storeGeneratedRound } from "./round-store";

export const runtime = "nodejs";

type CustomAmazonRuntimeEnv = {
  readonly isTestEnvironment: boolean;
};

type StoreGeneratedRound = (item: ProviderGeneratedItem) => GeneratedItem;

type CustomAmazonPostHandlerOptions = {
  readonly createProvider: (
    env: CustomAmazonRuntimeEnv,
  ) => GenerateCustomAmazonItemProvider;
  readonly readRuntimeEnv: () => CustomAmazonRuntimeEnv;
  readonly storeRound: StoreGeneratedRound;
  readonly isOriginAllowed?: RequestPredicate;
  readonly rateLimiter?: RequestPredicate;
};

export function createCustomAmazonPostHandler({
  createProvider,
  readRuntimeEnv,
  storeRound,
  isOriginAllowed = isAllowedOrigin,
  rateLimiter = defaultRateLimiter,
}: CustomAmazonPostHandlerOptions): (request: NextRequest) => Promise<Response> {
  return async function customAmazonPostHandler(
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

    try {
      const body = await readRequestJson(request);
      const provider = createProvider(readRuntimeEnv());
      const result = await provider({
        query: isRecord(body) ? body.query : undefined,
      });

      if (!result.ok) {
        return customAmazonErrorResponse(result.error);
      }

      return NextResponse.json(storeRound(result.item));
    } catch (error) {
      console.error("Custom Amazon item provider error:", error);
      return NextResponse.json(
        { error: "Failed to store custom Amazon query." },
        { status: 500 },
      );
    }
  };
}

const defaultRateLimiter = createItemGenerationRateLimiter();

export const POST = createCustomAmazonPostHandler({
  createProvider: createLegacyCustomAmazonProvider,
  readRuntimeEnv,
  storeRound: storeGeneratedRound,
});

function createLegacyCustomAmazonProvider({
  isTestEnvironment,
}: CustomAmazonRuntimeEnv): GenerateCustomAmazonItemProvider {
  const amazonLookup = isTestEnvironment
    ? createFakeAmazonLookup()
    : createFetchAmazonLookup({ fetchImpl: (input, init) => fetch(input, init) });

  return createCustomAmazonItemProvider({ amazonLookup });
}

function readRuntimeEnv(): CustomAmazonRuntimeEnv {
  return {
    isTestEnvironment: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  };
}

function customAmazonErrorResponse(error: ItemGenerationError): Response {
  if (error.code === "invalid_custom_query") {
    return NextResponse.json({ error: "Query is required." }, { status: 400 });
  }

  if (error.code === "amazon_price_unavailable") {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  return NextResponse.json(
    { error: "Failed to store custom Amazon query." },
    { status: 500 },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
