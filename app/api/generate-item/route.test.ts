import { GoogleGenAI } from "@google/genai";
import type { NextRequest } from "next/server";
import { afterEach, vi } from "vitest";
import { clearRoundStoreForTests } from "../round-store";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    return {
      models: {
        generateContent: mocks.generateContent,
      },
    };
  }),
  Type: {
    OBJECT: "OBJECT",
    STRING: "STRING",
    NUMBER: "NUMBER",
  },
}));

const originalApiKey = process.env.GEMINI_API_KEY;

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/generate-item", {
    method: "POST",
    body: JSON.stringify(body),
  }) as NextRequest;
}

function rawRequest(body: string): NextRequest {
  return new Request("http://localhost/api/generate-item", {
    method: "POST",
    body,
  }) as NextRequest;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalApiKey;
  }

  vi.clearAllMocks();
  clearRoundStoreForTests();
});

describe("POST /api/generate-item", () => {
  it("returns 500 when GEMINI_API_KEY is missing", async () => {
    delete process.env.GEMINI_API_KEY;

    const response = await POST(request({ mode: "Cosmic Scale" }));

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({
      error: "Item generation is not configured.",
    });
    expect(GoogleGenAI).not.toHaveBeenCalled();
  });

  it("returns a valid generated item from the provider", async () => {
    process.env.GEMINI_API_KEY = "test-api-key";
    const item = {
      item_title: "Seconds in an hour",
      category: "Fermi Math & Geometry",
      context_clue: "An hour contains 60 minutes, each with 60 seconds.",
      true_value: 3600,
    };
    mocks.generateContent.mockResolvedValue({ text: JSON.stringify(item) });

    const response = await POST(request({ mode: "Fermi Math & Geometry" }));

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toEqual({
      round_id: expect.any(String),
      item_title: item.item_title,
      category: item.category,
      context_clue: item.context_clue,
    });
    expect(body).not.toHaveProperty("true_value");
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: "test-api-key" });
    expect(mocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-2.5-flash",
        contents: expect.stringContaining(
          "Requested mode: Fermi Math & Geometry",
        ),
      }),
    );
  });

  it("returns 502 for malformed or invalid provider responses", async () => {
    process.env.GEMINI_API_KEY = "test-api-key";

    mocks.generateContent.mockResolvedValueOnce({ text: "not json" });
    const malformed = await POST(request({ mode: "Cosmic Scale" }));

    expect(malformed.status).toBe(502);
    expect(await readJson(malformed)).toEqual({
      error: "Item provider returned an invalid item.",
    });

    mocks.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        item_title: "Bad Value",
        category: "Cosmic Scale",
        context_clue: "The value is incorrectly typed.",
        true_value: "123",
      }),
    });
    const invalid = await POST(request({ mode: "Cosmic Scale" }));

    expect(invalid.status).toBe(502);
    expect(await readJson(invalid)).toEqual({
      error: "Item provider returned an invalid item.",
    });
  });

  it("defaults an invalid requested mode to Chaos Quant", async () => {
    process.env.GEMINI_API_KEY = "test-api-key";
    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({
        item_title: "Cards in a deck",
        category: "Chaos Quant",
        context_clue: "Use a standard French-suited deck without jokers.",
        true_value: 52,
      }),
    });

    const response = await POST(request({ mode: "Live Market Prices" }));

    expect(response.status).toBe(200);
    expect(mocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.stringContaining("Requested mode: Chaos Quant"),
      }),
    );
  });

  it("defaults malformed or missing request bodies to Chaos Quant", async () => {
    process.env.GEMINI_API_KEY = "test-api-key";
    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({
        item_title: "Cards in a deck",
        category: "Chaos Quant",
        context_clue: "Use a standard French-suited deck without jokers.",
        true_value: 52,
      }),
    });

    const malformed = await POST(rawRequest("{not-json"));
    const empty = await POST(request({}));

    expect(malformed.status).toBe(200);
    expect(empty.status).toBe(200);
    expect(mocks.generateContent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        contents: expect.stringContaining("Requested mode: Chaos Quant"),
      }),
    );
    expect(mocks.generateContent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        contents: expect.stringContaining("Requested mode: Chaos Quant"),
      }),
    );
  });

  it("handles Amazon mode with a mock price in test env", async () => {
    process.env.GEMINI_API_KEY = "test-api-key";
    const item = {
      item_title: "PlayStation 5 Console",
      category: "Amazon",
      context_clue: "First result price on Amazon search",
      true_value: 0,
    };
    mocks.generateContent.mockResolvedValue({ text: JSON.stringify(item) });

    const response = await POST(request({ mode: "Amazon" }));

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toEqual({
      round_id: expect.any(String),
      item_title: item.item_title,
      category: item.category,
      context_clue: item.context_clue,
    });
  });
});
