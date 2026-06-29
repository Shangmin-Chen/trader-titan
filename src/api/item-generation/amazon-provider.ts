import { validateProviderItem, type ProviderGeneratedItem } from "../../lib/game";
import type {
  AmazonLookup,
  AmazonLookupResult,
  FetchLike,
  GenerateCustomAmazonItemProvider,
  GenerateItemProvider,
  ItemGenerationResult,
} from "./types";

export const DEFAULT_TEST_AMAZON_PRICE = 99.99;
export const CUSTOM_AMAZON_QUERY_MAX_LENGTH = 200;

const AMAZON_SEARCH_BASE_URL = "https://www.amazon.com/s?k=";
const AMAZON_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const AMAZON_ACCEPT_HEADER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const MIN_VALID_AMAZON_PRICE = 0;
const AD_MARKER_SCAN_LENGTH = 400;
const SEARCH_RESULT_PATTERN = /data-component-type=["']s-search-result["']/gi;
const PRICE_PATTERN =
  /class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)/i;
const H2_ARIA_LABEL_PATTERN = /<h2[^>]*aria-label=["']([^"']+)["']/i;
const H2_SPAN_PATTERN = /<h2\b[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const SPONSORED_PREFIX_PATTERN = /^Sponsored Ad\s*-\s*/i;

export type FetchAmazonLookupOptions = {
  readonly fetchImpl: FetchLike;
};

export type FakeAmazonLookupOptions = {
  readonly price?: number;
};

export type AmazonAwareItemProviderOptions = {
  readonly amazonLookup: AmazonLookup;
  readonly generateItem: GenerateItemProvider;
};

export type CustomAmazonItemProviderOptions = {
  readonly amazonLookup: AmazonLookup;
};

export function withAmazonPriceLookup({
  amazonLookup,
  generateItem,
}: AmazonAwareItemProviderOptions): GenerateItemProvider {
  return async (input): Promise<ItemGenerationResult> => {
    const generated = await generateItem(input);

    if (!generated.ok || input.mode !== "Amazon") {
      return generated;
    }

    const details = await amazonLookup(generated.item.item_title);
    if (details === null) {
      return amazonPriceUnavailable(
        `Could not fetch Amazon price for product "${generated.item.item_title}".`,
      );
    }

    const item: ProviderGeneratedItem = {
      ...generated.item,
      true_value: details.price,
      scraped_items: details.scraped_items,
      amazon_url: details.amazon_url,
    };

    if (!validateProviderItem(item).ok) {
      return invalidProviderItem();
    }

    return { ok: true, item };
  };
}

export function createCustomAmazonItemProvider({
  amazonLookup,
}: CustomAmazonItemProviderOptions): GenerateCustomAmazonItemProvider {
  return async ({ query }): Promise<ItemGenerationResult> => {
    const normalizedQuery = normalizeCustomAmazonQuery(query);

    if (normalizedQuery === null) {
      return {
        ok: false,
        error: {
          code: "invalid_custom_query",
          message: "Query is required.",
        },
      };
    }

    const details = await amazonLookup(normalizedQuery);
    if (details === null) {
      return amazonPriceUnavailable(
        `Could not fetch Amazon price for query "${normalizedQuery}".`,
      );
    }

    const item: ProviderGeneratedItem = {
      item_title: normalizedQuery,
      category: "Amazon",
      context_clue: `Amazon price for "${normalizedQuery}"`,
      true_value: details.price,
      scraped_items: details.scraped_items,
      amazon_url: details.amazon_url,
    };

    if (!validateProviderItem(item).ok) {
      return invalidProviderItem();
    }

    return { ok: true, item };
  };
}

export function createFetchAmazonLookup({
  fetchImpl,
}: FetchAmazonLookupOptions): AmazonLookup {
  return async (query: string): Promise<AmazonLookupResult | null> => {
    const amazonUrl = buildAmazonSearchUrl(query);

    try {
      const response = await fetchImpl(amazonUrl, {
        headers: {
          Accept: AMAZON_ACCEPT_HEADER,
          "User-Agent": AMAZON_USER_AGENT,
        },
      });

      if (!response.ok) {
        return null;
      }

      return parseAmazonSearchHtml(await response.text(), query, amazonUrl);
    } catch {
      return null;
    }
  };
}

export function createFakeAmazonLookup({
  price = DEFAULT_TEST_AMAZON_PRICE,
}: FakeAmazonLookupOptions = {}): AmazonLookup {
  return async (query: string): Promise<AmazonLookupResult> => ({
    price,
    scraped_items: [{ title: query, price }],
    amazon_url: buildAmazonSearchUrl(query),
  });
}

export function normalizeCustomAmazonQuery(query: unknown): string | null {
  if (typeof query !== "string") {
    return null;
  }

  const normalized = query.trim();
  return normalized.length > 0 && normalized.length <= CUSTOM_AMAZON_QUERY_MAX_LENGTH
    ? normalized
    : null;
}

export function buildAmazonSearchUrl(query: string): string {
  return `${AMAZON_SEARCH_BASE_URL}${encodeURIComponent(query)}`;
}

export function parseAmazonSearchHtml(
  html: string,
  query: string,
  amazonUrl: string = buildAmazonSearchUrl(query),
): AmazonLookupResult | null {
  const indices = findSearchResultIndices(html);
  const scrapedItems = indices.flatMap((idx, index): AmazonLookupResult["scraped_items"] => {
    const nextIdx = indices[index + 1] ?? html.length;
    const slice = html.slice(idx, nextIdx);

    if (slice.slice(0, AD_MARKER_SCAN_LENGTH).includes("AdHolder")) {
      return [];
    }

    const price = readPrice(slice);
    if (price === null) {
      return [];
    }

    return [
      {
        title: readTitle(slice, query),
        price,
      },
    ];
  });

  if (scrapedItems.length > 0) {
    return {
      price: scrapedItems[0].price,
      scraped_items: scrapedItems,
      amazon_url: amazonUrl,
    };
  }

  return null;
}

function findSearchResultIndices(html: string): number[] {
  const indices: number[] = [];
  let match: RegExpExecArray | null = SEARCH_RESULT_PATTERN.exec(html);

  while (match !== null) {
    indices.push(match.index);
    match = SEARCH_RESULT_PATTERN.exec(html);
  }

  SEARCH_RESULT_PATTERN.lastIndex = 0;
  return indices;
}

function readPrice(html: string): number | null {
  const match = PRICE_PATTERN.exec(html);
  return match?.[1] ? parseAmazonPrice(match[1]) : null;
}

function parseAmazonPrice(value: string): number | null {
  const price = Number.parseFloat(value.replaceAll(",", ""));
  return Number.isFinite(price) && price > MIN_VALID_AMAZON_PRICE ? price : null;
}

function readTitle(html: string, fallbackTitle: string): string {
  const ariaLabelMatch = H2_ARIA_LABEL_PATTERN.exec(html);
  const spanMatch = H2_SPAN_PATTERN.exec(html);
  const rawTitle = ariaLabelMatch?.[1] ?? spanMatch?.[1] ?? "";
  const title = decodeHtmlEntities(rawTitle)
    .replace(HTML_TAG_PATTERN, "")
    .replace(SPONSORED_PREFIX_PATTERN, "")
    .trim();

  return title.length > 0 ? title : fallbackTitle;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function amazonPriceUnavailable(message: string): ItemGenerationResult {
  return {
    ok: false,
    error: {
      code: "amazon_price_unavailable",
      message,
    },
  };
}

function invalidProviderItem(): ItemGenerationResult {
  return {
    ok: false,
    error: {
      code: "invalid_provider_response",
      message: "Item provider returned an invalid item.",
    },
  };
}
