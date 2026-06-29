import type {
  GameMode,
  ProviderGeneratedItem,
  ScrapedAmazonItem,
} from "../../lib/game";

export type ItemGenerationErrorCode =
  | "amazon_price_unavailable"
  | "invalid_custom_query"
  | "invalid_provider_response"
  | "missing_api_key"
  | "provider_failed";

export type ItemGenerationError = {
  readonly code: ItemGenerationErrorCode;
  readonly message: string;
  readonly cause?: unknown;
};

export type ItemGenerationResult =
  | {
      readonly ok: true;
      readonly item: ProviderGeneratedItem;
    }
  | {
      readonly ok: false;
      readonly error: ItemGenerationError;
    };

export type GenerateItemInput = {
  readonly mode: GameMode;
};

export type GenerateItemProvider = (
  input: GenerateItemInput,
) => Promise<ItemGenerationResult>;

export type GenerateCustomAmazonItemInput = {
  readonly query: unknown;
};

export type GenerateCustomAmazonItemProvider = (
  input: GenerateCustomAmazonItemInput,
) => Promise<ItemGenerationResult>;

export type AmazonLookupResult = {
  readonly price: number;
  readonly scraped_items: ScrapedAmazonItem[];
  readonly amazon_url: string;
};

export type AmazonLookup = (query: string) => Promise<AmazonLookupResult | null>;

export type FetchResponseLike = {
  readonly ok: boolean;
  text: () => Promise<string>;
};

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<FetchResponseLike>;

