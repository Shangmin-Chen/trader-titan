import type { NextRequest } from "next/server";
import { afterEach, vi } from "vitest";
import type { GenerateCustomAmazonItemProvider } from "./item-generation";
import { clearRoundStoreForTests } from "./round-store";
import { createCustomAmazonPostHandler } from "./generate-custom-amazon-item";

function request(body: unknown, headers: HeadersInit = {}): NextRequest {
  return new Request("http://localhost/api/generate-custom-amazon-item", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as NextRequest;
}

function rawRequest(body: string): NextRequest {
  return new Request("http://localhost/api/generate-custom-amazon-item", {
    method: "POST",
    body,
  }) as NextRequest;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

afterEach(() => {
  vi.clearAllMocks();
  clearRoundStoreForTests();
});

describe("POST /api/generate-custom-amazon-item", () => {
  it("stores private Amazon values while returning only the public item", async () => {
    const privateItem = {
      item_title: "Sony Headphones",
      category: "Amazon",
      context_clue: 'Amazon price for "Sony Headphones"',
      true_value: 149.99,
      scraped_items: [{ title: "Sony Headphones", price: 149.99 }],
      amazon_url: "https://www.amazon.com/s?k=Sony%20Headphones",
    };
    const provider = vi.fn<GenerateCustomAmazonItemProvider>(async () => ({
      ok: true,
      item: privateItem,
    }));
    const storeRound = vi.fn(() => ({
      round_id: "round-custom-1",
      item_title: privateItem.item_title,
      category: privateItem.category,
      context_clue: privateItem.context_clue,
    }));
    const handler = createCustomAmazonPostHandler({
      createProvider: () => provider,
      readRuntimeEnv: () => ({ isTestEnvironment: true }),
      storeRound,
    });

    const response = await handler(request({ query: "Sony Headphones" }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(provider).toHaveBeenCalledWith({ query: "Sony Headphones" });
    expect(storeRound).toHaveBeenCalledWith(privateItem);
    expect(body).toEqual({
      round_id: "round-custom-1",
      item_title: privateItem.item_title,
      category: privateItem.category,
      context_clue: privateItem.context_clue,
    });
    expect(JSON.stringify(body)).not.toContain("true_value");
    expect(JSON.stringify(body)).not.toContain("amazon_url");
  });

  it("returns 400 for malformed JSON or invalid query input", async () => {
    const provider = vi.fn<GenerateCustomAmazonItemProvider>(async () => ({
      ok: false,
      error: {
        code: "invalid_custom_query",
        message: "Query is required.",
      },
    }));
    const handler = createCustomAmazonPostHandler({
      createProvider: () => provider,
      readRuntimeEnv: () => ({ isTestEnvironment: true }),
      storeRound: vi.fn(),
    });

    const malformed = await handler(rawRequest("{not-json"));
    const emptyQuery = await handler(request({ query: "   " }));

    expect(malformed.status).toBe(400);
    expect(emptyQuery.status).toBe(400);
    expect(await readJson(malformed)).toEqual({ error: "Query is required." });
    expect(await readJson(emptyQuery)).toEqual({ error: "Query is required." });
  });

  it("shares origin and rate-limit protections with item generation", async () => {
    const createProvider = vi.fn<() => GenerateCustomAmazonItemProvider>(() => async () => ({
      ok: false,
      error: {
        code: "invalid_custom_query",
        message: "Query is required.",
      },
    }));
    const crossOriginHandler = createCustomAmazonPostHandler({
      createProvider,
      readRuntimeEnv: () => ({ isTestEnvironment: true }),
      storeRound: vi.fn(),
    });
    const rateLimitedHandler = createCustomAmazonPostHandler({
      createProvider,
      readRuntimeEnv: () => ({ isTestEnvironment: true }),
      storeRound: vi.fn(),
      rateLimiter: () => false,
    });

    const crossOrigin = await crossOriginHandler(
      request({ query: "Sony Headphones" }, { origin: "http://evil.example" }),
    );
    const rateLimited = await rateLimitedHandler(request({ query: "Sony Headphones" }));

    expect(crossOrigin.status).toBe(403);
    expect(rateLimited.status).toBe(429);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("maps Amazon lookup failures without leaking provider internals", async () => {
    const provider = vi.fn<GenerateCustomAmazonItemProvider>(async () => ({
      ok: false,
      error: {
        code: "amazon_price_unavailable",
        message: "Could not fetch Amazon price for query \"Sony Headphones\".",
      },
    }));
    const handler = createCustomAmazonPostHandler({
      createProvider: () => provider,
      readRuntimeEnv: () => ({ isTestEnvironment: true }),
      storeRound: vi.fn(),
    });

    const response = await handler(request({ query: "Sony Headphones" }));

    expect(response.status).toBe(502);
    expect(await readJson(response)).toEqual({
      error: "Could not fetch Amazon price for query \"Sony Headphones\".",
    });
  });
});
