import { MAX_PLAYABLE_ABSOLUTE_VALUE } from "../../lib/game";
import {
  CUSTOM_AMAZON_QUERY_MAX_LENGTH,
  createCustomAmazonItemProvider,
  createDeterministicItemProvider,
  createFakeAmazonLookup,
  createFetchAmazonLookup,
  createGeminiItemProvider,
  DEFAULT_TEST_AMAZON_PRICE,
  normalizeCustomAmazonQuery,
  parseAmazonSearchHtml,
  parseProviderItemJson,
  withAmazonPriceLookup,
  type AmazonLookup,
  type GeminiTextGenerator,
  type GeminiTextGeneratorFactory,
  type ItemGenerationResult,
} from ".";

type ItemGenerationSuccess = Extract<ItemGenerationResult, { readonly ok: true }>;
type ItemGenerationFailure = Extract<ItemGenerationResult, { readonly ok: false }>;

function expectSuccess(result: ItemGenerationResult): ItemGenerationSuccess {
  if (!result.ok) {
    throw new Error(`Expected success, received ${result.error.code}`);
  }

  return result;
}

function expectFailure(result: ItemGenerationResult): ItemGenerationFailure {
  if (result.ok) {
    throw new Error("Expected failure, received success");
  }

  return result;
}

function createTextFactory(text: string | undefined): {
  readonly createTextGenerator: GeminiTextGeneratorFactory;
  readonly generateText: GeminiTextGenerator;
} {
  const generateText = vi.fn<GeminiTextGenerator>(async () => text);
  const createTextGenerator = vi.fn<GeminiTextGeneratorFactory>(() => generateText);

  return { createTextGenerator, generateText };
}

describe("Gemini item provider", () => {
  it("returns a missing API key failure without constructing a client", async () => {
    const { createTextGenerator } = createTextFactory("{}");
    const provider = createGeminiItemProvider({
      apiKey: undefined,
      createTextGenerator,
      marketConfig: null,
    });

    const result = expectFailure(await provider({ mode: "Cosmic Scale" }));

    expect(result.error.code).toBe("missing_api_key");
    expect(result.error.message).toBe("Item generation is not configured.");
    expect(createTextGenerator).not.toHaveBeenCalled();
  });

  it("rejects malformed provider JSON", async () => {
    const { createTextGenerator } = createTextFactory("not json");
    const provider = createGeminiItemProvider({
      apiKey: "test-api-key",
      createTextGenerator,
      marketConfig: null,
    });

    const result = expectFailure(await provider({ mode: "Cosmic Scale" }));

    expect(result.error.code).toBe("invalid_provider_response");
    expect(result.error.message).toBe("Item provider returned an invalid item.");
  });

  it("rejects numeric true values outside the playable range", async () => {
    const { createTextGenerator } = createTextFactory(
      JSON.stringify({
        item_title: "Too large",
        category: "Cosmic Scale",
        context_clue: "The generated value is too large for settlement.",
        true_value: MAX_PLAYABLE_ABSOLUTE_VALUE + 1,
      }),
    );
    const provider = createGeminiItemProvider({
      apiKey: "test-api-key",
      createTextGenerator,
      marketConfig: null,
    });

    const result = expectFailure(await provider({ mode: "Cosmic Scale" }));

    expect(result.error.code).toBe("invalid_provider_response");
  });
});

describe("provider JSON parser", () => {
  it("accepts strict and prose-wrapped provider item JSON", () => {
    const item = {
      item_title: "Seconds in an hour",
      category: "Fermi Math & Geometry",
      context_clue: "60 minutes times 60 seconds.",
      true_value: 3_600,
    };

    expect(parseProviderItemJson(JSON.stringify(item))).toEqual(item);
    expect(parseProviderItemJson(`Here is the item: ${JSON.stringify(item)}.`)).toEqual(item);
  });

  it("rejects malformed provider item shapes", () => {
    const validShape = {
      item_title: "Seconds in an hour",
      category: "Fermi Math & Geometry",
      context_clue: "60 minutes times 60 seconds.",
      true_value: 3_600,
    };

    expect(parseProviderItemJson(undefined)).toBeNull();
    expect(parseProviderItemJson("")).toBeNull();
    expect(parseProviderItemJson(JSON.stringify([]))).toBeNull();
    expect(parseProviderItemJson(JSON.stringify(null))).toBeNull();
    expect(parseProviderItemJson(JSON.stringify({ ...validShape, extra: "nope" }))).toBeNull();
    expect(parseProviderItemJson(JSON.stringify({ ...validShape, context_clue: " " }))).toBeNull();
    expect(parseProviderItemJson(JSON.stringify({ ...validShape, true_value: "3600" }))).toBeNull();
    expect(parseProviderItemJson(
      JSON.stringify({
        ...validShape,
        true_value: MAX_PLAYABLE_ABSOLUTE_VALUE + 1,
      }),
    )).toBeNull();
  });
});

describe("Amazon item provider", () => {
  it("uses the deterministic fake Amazon lookup for Amazon mode", async () => {
    const provider = withAmazonPriceLookup({
      amazonLookup: createFakeAmazonLookup(),
      generateItem: createDeterministicItemProvider({
        item: {
          item_title: "PlayStation 5 Console",
          category: "Amazon",
          context_clue: "First result price on Amazon search",
          true_value: 0,
        },
      }),
    });

    const result = expectSuccess(await provider({ mode: "Amazon" }));

    expect(result.item).toEqual({
      item_title: "PlayStation 5 Console",
      category: "Amazon",
      context_clue: "First result price on Amazon search",
      true_value: DEFAULT_TEST_AMAZON_PRICE,
      scraped_items: [
        {
          title: "PlayStation 5 Console",
          price: DEFAULT_TEST_AMAZON_PRICE,
        },
      ],
      amazon_url: "https://www.amazon.com/s?k=PlayStation%205%20Console",
    });
  });

  it("parses organic Amazon search result prices and skips ads", () => {
    const result = parseAmazonSearchHtml(
      `
      <div data-component-type="s-search-result">
        <div class="AdHolder"></div>
        <h2 aria-label="Sponsored Ad - Bad Item"></h2>
        <span class="a-offscreen">$1.00</span>
      </div>
      <div data-component-type="s-search-result">
        <h2 aria-label="Nintendo Switch &amp; Mario Bundle"></h2>
        <span class="a-offscreen">$299.99</span>
      </div>
      `,
      "Nintendo Switch",
    );

    expect(result).toEqual({
      price: 299.99,
      scraped_items: [
        {
          title: "Nintendo Switch & Mario Bundle",
          price: 299.99,
        },
      ],
      amazon_url: "https://www.amazon.com/s?k=Nintendo%20Switch",
    });
  });

  it("returns null when only sponsored or global fallback prices are present", () => {
    const result = parseAmazonSearchHtml(
      `
      <div data-component-type="s-search-result">
        <div class="AdHolder"></div>
        <h2 aria-label="Sponsored Ad - Bad Item"></h2>
        <span class="a-offscreen">$1.00</span>
      </div>
      <section>
        <span class="a-offscreen">$999.99</span>
      </section>
      `,
      "Nintendo Switch",
    );

    expect(result).toBeNull();
  });

  it("parses comma prices from organic Amazon search results", () => {
    const result = parseAmazonSearchHtml(
      `
      <div data-component-type="s-search-result">
        <h2><span>Luxury Espresso Machine</span></h2>
        <span class="a-offscreen">$1,299.99</span>
      </div>
      `,
      "Espresso Machine",
    );

    expect(result?.price).toBe(1_299.99);
    expect(result?.scraped_items[0]?.title).toBe("Luxury Espresso Machine");
  });

  it("supports fetch-injected Amazon lookup", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => `
        <div data-component-type="s-search-result">
          <h2 aria-label="Sony Headphones"></h2>
          <span class="a-offscreen">$149.50</span>
        </div>
      `,
    }));
    const lookup = createFetchAmazonLookup({ fetchImpl });

    const result = await lookup("Sony Headphones");

    expect(result).toEqual({
      price: 149.5,
      scraped_items: [{ title: "Sony Headphones", price: 149.5 }],
      amazon_url: "https://www.amazon.com/s?k=Sony%20Headphones",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.amazon.com/s?k=Sony%20Headphones",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: expect.any(String),
          "User-Agent": expect.any(String),
        }),
      }),
    );
  });
});

describe("custom Amazon item provider", () => {
  it("validates custom queries before lookup", async () => {
    const fakeLookup = createFakeAmazonLookup();
    const amazonLookup = vi.fn<AmazonLookup>((query) => fakeLookup(query));
    const provider = createCustomAmazonItemProvider({ amazonLookup });

    const missingQuery = expectFailure(await provider({ query: "   " }));
    const validQuery = expectSuccess(await provider({ query: "  Sony Headphones  " }));

    expect(missingQuery.error.code).toBe("invalid_custom_query");
    expect(missingQuery.error.message).toBe("Query is required.");
    expect(amazonLookup).toHaveBeenCalledTimes(1);
    expect(amazonLookup).toHaveBeenCalledWith("Sony Headphones");
    expect(validQuery.item).toEqual({
      item_title: "Sony Headphones",
      category: "Amazon",
      context_clue: 'Amazon price for "Sony Headphones"',
      true_value: DEFAULT_TEST_AMAZON_PRICE,
      scraped_items: [{ title: "Sony Headphones", price: DEFAULT_TEST_AMAZON_PRICE }],
      amazon_url: "https://www.amazon.com/s?k=Sony%20Headphones",
    });
  });

  it("rejects non-string and overlong custom queries", () => {
    expect(normalizeCustomAmazonQuery(null)).toBeNull();
    expect(normalizeCustomAmazonQuery({ query: "Sony Headphones" })).toBeNull();
    expect(normalizeCustomAmazonQuery(["Sony Headphones"])).toBeNull();
    expect(normalizeCustomAmazonQuery(0)).toBeNull();
    expect(normalizeCustomAmazonQuery("x".repeat(CUSTOM_AMAZON_QUERY_MAX_LENGTH + 1))).toBeNull();
    expect(normalizeCustomAmazonQuery(" Sony Headphones ")).toBe("Sony Headphones");
  });
});
