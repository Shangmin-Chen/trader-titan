import type {
  GeneratedItem,
  ScrapedAmazonItem,
  SettledGeneratedItem,
} from "../lib/game";
import { validateProviderItem } from "../lib/game";

const PRIVATE_GENERATED_ITEM_KIND = "trader-titan.private-generated-item";
const PRIVATE_GENERATED_ITEM_VERSION = 1;
const PRIVATE_GENERATED_ITEM_STORAGE_PREFIX = "room:private-generated-item:v1:";
const PRIVATE_GENERATED_ITEM_KEYS = [
  "kind",
  "version",
  "roundId",
  "item",
] as const;
const SETTLED_ITEM_KEYS = [
  "round_id",
  "item_title",
  "category",
  "context_clue",
  "true_value",
  "scraped_items",
  "amazon_url",
] as const;
const SCRAPED_ITEM_KEYS = ["title", "price"] as const;

export type PrivateGeneratedItemEnvelope = Readonly<{
  kind: typeof PRIVATE_GENERATED_ITEM_KIND;
  version: typeof PRIVATE_GENERATED_ITEM_VERSION;
  roundId: string;
  item: SettledGeneratedItem;
}>;

export type PrivateGeneratedItemLoadResult =
  | Readonly<{ ok: true; item: SettledGeneratedItem }>
  | Readonly<{ ok: false; reason: "missing" | "invalid" }>;

/**
 * Private item keys are derived only from round ids so the room envelope can
 * persist public state independently from settlement-only values.
 */
export function privateGeneratedItemStorageKey(roundId: string): string {
  return `${PRIVATE_GENERATED_ITEM_STORAGE_PREFIX}${roundId}`;
}

export function privateGeneratedItemStoragePrefix(): string {
  return PRIVATE_GENERATED_ITEM_STORAGE_PREFIX;
}

export function createSettledGeneratedItem(
  roundId: string,
  item: Omit<SettledGeneratedItem, "round_id">,
): SettledGeneratedItem {
  return {
    round_id: roundId,
    item_title: item.item_title,
    category: item.category,
    context_clue: item.context_clue,
    true_value: item.true_value,
    ...(item.scraped_items === undefined ? {} : { scraped_items: item.scraped_items }),
    ...(item.amazon_url === undefined ? {} : { amazon_url: item.amazon_url }),
  };
}

export function toGeneratedItem(item: SettledGeneratedItem): GeneratedItem {
  return {
    round_id: item.round_id,
    item_title: item.item_title,
    category: item.category,
    context_clue: item.context_clue,
  };
}

export function toPrivateGeneratedItemEnvelope(
  item: SettledGeneratedItem,
): PrivateGeneratedItemEnvelope {
  return {
    kind: PRIVATE_GENERATED_ITEM_KIND,
    version: PRIVATE_GENERATED_ITEM_VERSION,
    roundId: item.round_id,
    item,
  };
}

export function loadPrivateGeneratedItemEnvelope(
  envelope: unknown,
  expectedRoundId: string,
): PrivateGeneratedItemLoadResult {
  if (envelope === undefined) {
    return { ok: false, reason: "missing" };
  }

  if (
    !isRecord(envelope) ||
    !hasOnlyKeys(envelope, PRIVATE_GENERATED_ITEM_KEYS) ||
    envelope.kind !== PRIVATE_GENERATED_ITEM_KIND ||
    envelope.version !== PRIVATE_GENERATED_ITEM_VERSION ||
    envelope.roundId !== expectedRoundId
  ) {
    return { ok: false, reason: "invalid" };
  }

  const item = decodeSettledGeneratedItem(envelope.item);

  if (item === null || item.round_id !== expectedRoundId) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, item };
}

function decodeSettledGeneratedItem(value: unknown): SettledGeneratedItem | null {
  if (!isRecord(value) || !hasOnlyKeys(value, SETTLED_ITEM_KEYS)) {
    return null;
  }

  if (
    typeof value.round_id !== "string" ||
    typeof value.item_title !== "string" ||
    typeof value.category !== "string" ||
    typeof value.context_clue !== "string" ||
    typeof value.true_value !== "number" ||
    !Number.isFinite(value.true_value)
  ) {
    return null;
  }

  let scrapedItems: ScrapedAmazonItem[] | undefined;

  if (value.scraped_items !== undefined) {
    const decodedScrapedItems = decodeScrapedItems(value.scraped_items);

    if (decodedScrapedItems === null) {
      return null;
    }

    scrapedItems = decodedScrapedItems;
  }

  if (value.amazon_url !== undefined && typeof value.amazon_url !== "string") {
    return null;
  }

  const item: SettledGeneratedItem = {
    round_id: value.round_id,
    item_title: value.item_title,
    category: value.category,
    context_clue: value.context_clue,
    true_value: value.true_value,
    ...(scrapedItems === undefined ? {} : { scraped_items: scrapedItems }),
    ...(typeof value.amazon_url === "string" ? { amazon_url: value.amazon_url } : {}),
  };

  return validateProviderItem(item).ok ? item : null;
}

function decodeScrapedItems(value: unknown): ScrapedAmazonItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const items: ScrapedAmazonItem[] = [];

  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, SCRAPED_ITEM_KEYS) ||
      typeof item.title !== "string" ||
      typeof item.price !== "number" ||
      !Number.isFinite(item.price)
    ) {
      return null;
    }

    items.push({
      title: item.title,
      price: item.price,
    });
  }

  return items;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);

  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
