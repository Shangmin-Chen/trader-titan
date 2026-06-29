import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse, type NextRequest } from "next/server";
import { MAX_PLAYABLE_ABSOLUTE_VALUE, type GameMode, type ScrapedAmazonItem } from "../../../src/lib/game";
import { storeGeneratedRound } from "../round-store";
import { parseGenerateItemBody, parseProviderItem } from "./schema";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import zlib from "node:zlib";

export const runtime = "nodejs";

const GEMINI_MODEL = "gemini-2.5-flash";

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    item_title: {
      type: Type.STRING,
      description: "Short display title for the generated numeric item."
    },
    category: {
      type: Type.STRING,
      description: "The requested generation mode or a concise subcategory."
    },
    context_clue: {
      type: Type.STRING,
      description:
        "One compact clue that gives enough static context for a player to reason about the quantity."
    },
    true_value: {
      type: Type.NUMBER,
      description:
        "The exact numeric answer as a JSON number only, with no commas, units, symbols, or formatting."
    }
  },
  required: ["item_title", "category", "context_clue", "true_value"],
  propertyOrdering: ["item_title", "category", "context_clue", "true_value"]
};

export async function POST(request: NextRequest) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }

  if (!consumeRateLimit(request)) {
    return NextResponse.json({ error: "Item generation rate limit exceeded." }, { status: 429 });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Item generation is not configured." },
      { status: 500 }
    );
  }

  const { mode } = parseGenerateItemBody(await readRequestJson(request));
  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: buildPrompt(mode),
      config: {
        responseMimeType: "application/json",
        responseSchema
      }
    });

    const item = parseProviderItem(response.text);

    if (item === null) {
      return NextResponse.json(
        { error: "Item provider returned an invalid item." },
        { status: 502 }
      );
    }

    if (mode === "Amazon") {
      const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
      if (isTest) {
        item.true_value = 99.99;
        item.scraped_items = [{ title: item.item_title, price: 99.99 }];
        item.amazon_url = `https://www.amazon.com/s?k=${encodeURIComponent(item.item_title)}`;
      } else {
        const details = await fetchAmazonDetails(item.item_title);
        if (details === null || details.price === null) {
          return NextResponse.json(
            { error: `Could not fetch Amazon price for product "${item.item_title}".` },
            { status: 502 }
          );
        }
        item.true_value = details.price;
        item.scraped_items = details.scraped_items;
        item.amazon_url = details.amazon_url;
      }
    }

    return NextResponse.json(storeGeneratedRound(item));
  } catch (error) {
    console.error("Item provider error:", error);
    return NextResponse.json(
      { error: "Item provider could not generate an item." },
      { status: 502 }
    );
  }
}

async function readRequestJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const rateLimitBuckets = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;

function isAllowedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

function consumeRateLimit(request: NextRequest): boolean {
  const key =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(key) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (bucket.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitBuckets.set(key, bucket);
    return false;
  }

  bucket.push(now);
  rateLimitBuckets.set(key, bucket);
  return true;
}

interface MarketConfig {
  systemInstructions?: string;
  modeGuidance?: Record<string, string>;
}

function loadMarketConfig(): MarketConfig | null {
  try {
    const configPath = path.join(process.cwd(), "config", "gemini-markets.json");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8");
      return JSON.parse(content) as MarketConfig;
    }
  } catch (error) {
    console.error("Failed to load market config:", error);
  }
  return null;
}

interface AmazonScrapedResult {
  price: number | null;
  scraped_items: ScrapedAmazonItem[];
  amazon_url: string;
}

async function fetchAmazonDetails(item: string): Promise<AmazonScrapedResult | null> {
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(item)}`;
  try {
    const buffer = execSync(
      `curl -s -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" "${url}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );

    let html = "";
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      html = zlib.gunzipSync(buffer).toString();
    } else {
      html = buffer.toString();
    }

    const searchResultRegex = /data-component-type="s-search-result"/g;
    let match;
    const indices: number[] = [];
    while ((match = searchResultRegex.exec(html)) !== null) {
      indices.push(match.index);
    }

    const scraped_items: ScrapedAmazonItem[] = [];

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const nextIdx = indices[i + 1] || html.length;
      const slice = html.slice(idx, nextIdx);

      const isAd = slice.slice(0, 400).includes("AdHolder");
      if (isAd) continue;

      // Extract title from aria-label inside h2 tag
      const ariaLabelRegex = /<h2[^>]*aria-label="([^"]+)"/i;
      const ariaLabelMatch = ariaLabelRegex.exec(slice);

      const offscreenRegex = /class="a-offscreen"[^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)/i;
      const priceMatch = offscreenRegex.exec(slice);

      if (priceMatch) {
        const priceVal = parseFloat(priceMatch[1].replace(/,/g, ""));
        if (Number.isFinite(priceVal) && priceVal > 0) {
          const rawTitle = ariaLabelMatch ? ariaLabelMatch[1] : "";
          const title = rawTitle.replace(/^Sponsored Ad\s*-\s*/i, "").trim() || item;
          scraped_items.push({ title, price: priceVal });
        }
      }
    }

    if (scraped_items.length > 0) {
      return {
        price: scraped_items[0].price,
        scraped_items,
        amazon_url: url,
      };
    }

    // Backup fallback if we couldn't parse organic results
    const offscreenRegex = /class="a-offscreen"[^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)/gi;
    const firstMatch = offscreenRegex.exec(html);
    if (firstMatch && firstMatch[1]) {
      const priceVal = parseFloat(firstMatch[1].replace(/,/g, ""));
      if (Number.isFinite(priceVal) && priceVal > 0) {
        return {
          price: priceVal,
          scraped_items: [{ title: item, price: priceVal }],
          amazon_url: url,
        };
      }
    }
  } catch (error) {
    console.error("Failed to fetch Amazon details via curl:", error);
  }
  return null;
}

function buildPrompt(mode: GameMode): string {
  const config = loadMarketConfig();
  
  const systemInstructions = config?.systemInstructions || "Generate one numeric game item for Titan Trader.";
  
  const defaults: Record<string, string> = {
    "Fermi Math & Geometry": "create a static estimation, math, or geometry quantity with enough fixed dimensions or assumptions in the clue to compute the answer.",
    "Static Landmarks & History": "use a static, absolute landmark or historical metric, date, distance, height, count, or duration that does not depend on current events.",
    "Cosmic Scale": "use a stable astronomical or physical scale, distance, mass, count, duration, or ratio based on canonical constants or long-settled facts.",
    "Chaos Quant": "make a surprising static quantitative item from math, fixed rules, durable objects, or timeless facts.",
    "Amazon": "Generate a popular, widely-known physical product sold on Amazon. Examples: 'Apple iPad Air', 'Sony PlayStation 5', 'Nintendo Switch'. Choose items that have a relatively stable and well-known price range. Do NOT return the actual price, just return a dummy value of 0 for true_value."
  };

  const modeGuidance = config?.modeGuidance?.[mode] || defaults[mode] || "";

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
