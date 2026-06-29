import { randomUUID } from "node:crypto";
import { calculateSettlement } from "../../src/lib/game";
import type {
  GeneratedItem,
  ProviderGeneratedItem,
  Quote,
  Roles,
  RoundSettlement,
  SettledGeneratedItem,
  TradeSide,
} from "../../src/lib/game";

const ROUND_TTL_MS = 30 * 60 * 1000;

type StoredRound = {
  createdAt: number;
  item: ProviderGeneratedItem;
  market?: {
    quote: Quote;
    roles: Roles;
    roundNumber: number;
  };
  settlement?: SettledRound;
  settled: boolean;
};

const rounds = new Map<string, StoredRound>();

export type CommitRoundMarketResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_committed" | "settled" };

type SettledRound = {
  item: SettledGeneratedItem;
  settlement: RoundSettlement;
};

export function storeGeneratedRound(item: ProviderGeneratedItem): GeneratedItem {
  pruneExpiredRounds();

  const roundId = randomUUID();
  rounds.set(roundId, {
    createdAt: Date.now(),
    item,
    settled: false,
  });

  return {
    round_id: roundId,
    item_title: item.item_title,
    category: item.category,
    context_clue: item.context_clue,
  };
}

export function commitRoundMarket({
  quote,
  roles,
  roundId,
  roundNumber,
}: {
  quote: Quote;
  roles: Roles;
  roundId: string;
  roundNumber: number;
}): CommitRoundMarketResult {
  pruneExpiredRounds();

  const stored = rounds.get(roundId);
  if (!stored) {
    return { ok: false, reason: "not_found" };
  }

  if (stored.settled) {
    return { ok: false, reason: "settled" };
  }

  const market = {
    quote: { ...quote },
    roles: { ...roles },
    roundNumber,
  };

  if (stored.market) {
    if (sameMarket(stored.market, market)) {
      return { ok: true };
    }

    return { ok: false, reason: "already_committed" };
  }

  rounds.set(roundId, {
    ...stored,
    market,
  });

  return { ok: true };
}

export function settleCommittedRound(
  roundId: string,
  side: TradeSide,
): SettledRound | null {
  pruneExpiredRounds();

  const stored = rounds.get(roundId);
  if (!stored) {
    return null;
  }

  if (stored.settlement) {
    return stored.settlement;
  }

  if (!stored.market || stored.settled) {
    return null;
  }

  const item: SettledGeneratedItem = {
    round_id: roundId,
    item_title: stored.item.item_title,
    category: stored.item.category,
    context_clue: stored.item.context_clue,
    true_value: stored.item.true_value,
    scraped_items: stored.item.scraped_items,
    amazon_url: stored.item.amazon_url,
  };
  const settlement = calculateSettlement({
    roundNumber: stored.market.roundNumber,
    itemTitle: item.item_title,
    trueValue: item.true_value,
    quote: stored.market.quote,
    side,
    roles: stored.market.roles,
  });

  const settled: SettledRound = { item, settlement };
  rounds.set(roundId, {
    ...stored,
    settlement: settled,
    settled: true,
  });

  return settled;
}

export function clearRoundStoreForTests() {
  rounds.clear();
}

function sameMarket(
  left: NonNullable<StoredRound["market"]>,
  right: NonNullable<StoredRound["market"]>,
): boolean {
  return (
    left.quote.bid === right.quote.bid &&
    left.quote.ask === right.quote.ask &&
    left.roles.marketMaker === right.roles.marketMaker &&
    left.roles.trader === right.roles.trader &&
    left.roundNumber === right.roundNumber
  );
}

function pruneExpiredRounds() {
  const cutoff = Date.now() - ROUND_TTL_MS;

  for (const [roundId, stored] of rounds) {
    if (stored.createdAt < cutoff) {
      rounds.delete(roundId);
    }
  }
}
