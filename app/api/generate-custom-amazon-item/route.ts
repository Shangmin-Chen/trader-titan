import { NextResponse, type NextRequest } from "next/server";
import { storeGeneratedRound } from "../round-store";
import { execSync } from "node:child_process";
import zlib from "node:zlib";
import { type ScrapedAmazonItem } from "../../../src/lib/game";

export const runtime = "nodejs";

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const query = String(body.query || "").trim();

    if (!query) {
      return NextResponse.json(
        { error: "Query is required." },
        { status: 400 }
      );
    }

    const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    let price: number | null = 99.99;
    let scraped_items: ScrapedAmazonItem[] = [{ title: query, price: 99.99 }];
    let amazon_url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;

    if (!isTest) {
      const details = await fetchAmazonDetails(query);
      if (details === null || details.price === null) {
        return NextResponse.json(
          { error: `Could not fetch Amazon price for query "${query}".` },
          { status: 502 }
        );
      }
      price = details.price;
      scraped_items = details.scraped_items;
      amazon_url = details.amazon_url;
    }

    const item = {
      item_title: query,
      category: "Amazon",
      context_clue: `Amazon price for "${query}"`,
      true_value: price,
      scraped_items,
      amazon_url,
    };

    const storedItem = storeGeneratedRound(item);
    return NextResponse.json(storedItem);
  } catch (error) {
    console.error("Custom Amazon item provider error:", error);
    return NextResponse.json(
      { error: "Failed to store custom Amazon query." },
      { status: 500 }
    );
  }
}
