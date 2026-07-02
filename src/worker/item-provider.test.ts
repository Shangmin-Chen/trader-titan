import { GoogleGenAI } from "@google/genai/web";
import { afterEach, describe, expect, it, vi } from "vitest";

import marketConfig from "../../config/gemini-markets.json";
import type { FetchLike, ItemGenerationResult } from "../api/item-generation";
import {
  createWorkerRoomItemProviders,
  itemGenerationErrorMessage,
} from "./item-provider";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));

vi.mock("@google/genai/web", () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    return {
      models: {
        generateContent: mocks.generateContent,
      },
    };
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Worker item provider", () => {
  it("builds Amazon Gemini prompts from the shared market config", async () => {
    const fetchImpl = createAmazonFetch();
    const providers = createWorkerRoomItemProviders({
      env: {
        GEMINI_API_KEY: "worker-test-api-key",
        WORKER_ITEM_PROVIDER: "gemini",
      },
      fetchImpl,
    });

    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({
        item_title: "Nicolas Cage Mermaid Pillow",
        category: "Amazon",
        context_clue: "First result price on Amazon search",
        true_value: 0,
      }),
    });

    const result = await providers.generateItem({ mode: "Amazon" });
    const prompt = readGeminiPrompt();

    expectSuccess(result);
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: "worker-test-api-key" });
    expect(prompt).toContain(marketConfig.systemInstructions);
    expect(prompt).toContain(marketConfig.modeGuidance.Amazon);
    expect(prompt).toContain("funny and unhinged");
    expect(prompt).toContain("normal electronics");
    expect(prompt).toContain("luxury or premium high-end items");
    expect(prompt).not.toContain("stable, common price range");
  });

  it("preserves Gemini provider failure behavior", async () => {
    const providerError = new Error("Gemini unavailable");
    const fetchImpl = createAmazonFetch();
    const providers = createWorkerRoomItemProviders({
      env: {
        GEMINI_API_KEY: "worker-test-api-key",
        WORKER_ITEM_PROVIDER: "gemini",
      },
      fetchImpl,
    });

    mocks.generateContent.mockRejectedValue(providerError);

    const result = expectFailure(await providers.generateItem({ mode: "Amazon" }));

    expect(result.error).toEqual({
      code: "provider_failed",
      message: "Item provider could not generate an item.",
      cause: providerError,
    });
    expect(itemGenerationErrorMessage(result.error)).toBe(
      "Item provider could not generate an item.",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function createAmazonFetch(): FetchLike {
  return vi.fn<FetchLike>(async () => ({
    ok: true,
    text: async () => `
      <div data-component-type="s-search-result">
        <h2 aria-label="Nicolas Cage Mermaid Pillow"></h2>
        <span class="a-offscreen">$24.99</span>
      </div>
    `,
  }));
}

function readGeminiPrompt(): string {
  const request = mocks.generateContent.mock.calls[0]?.[0];

  if (!isGeminiRequest(request)) {
    throw new Error("Expected Gemini generateContent to receive a prompt.");
  }

  return request.contents;
}

function expectSuccess(
  result: ItemGenerationResult,
): Extract<ItemGenerationResult, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected success, received ${result.error.code}`);
  }

  return result;
}

function expectFailure(
  result: ItemGenerationResult,
): Extract<ItemGenerationResult, { readonly ok: false }> {
  if (result.ok) {
    throw new Error("Expected failure, received success");
  }

  return result;
}

function isGeminiRequest(
  value: unknown,
): value is { readonly contents: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "contents" in value &&
    typeof value.contents === "string"
  );
}
