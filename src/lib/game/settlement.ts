import type {
  PendingTradeDecision,
  Quote,
  Roles,
  RoundForfeit,
  RoundSettlement,
  Scores,
  TradeSide,
} from "./types";

type SettlementInput = {
  roundNumber: number;
  itemTitle: string;
  trueValue: number;
  quote: Quote;
  side: TradeSide;
  roles: Roles;
  forcedByTimeout: boolean;
};

export function calculateSettlement(input: SettlementInput): RoundSettlement {
  if (input.side === "BUY") {
    const traderPnL = input.trueValue - input.quote.ask;

    return {
      roundNumber: input.roundNumber,
      itemTitle: input.itemTitle,
      side: input.side,
      transactionPrice: input.quote.ask,
      trueValue: input.trueValue,
      trader: input.roles.trader,
      marketMaker: input.roles.marketMaker,
      traderPnL,
      marketMakerPnL: -traderPnL,
      forcedByTimeout: input.forcedByTimeout,
    };
  }

  const traderPnL = input.quote.bid - input.trueValue;

  return {
    roundNumber: input.roundNumber,
    itemTitle: input.itemTitle,
    side: input.side,
    transactionPrice: input.quote.bid,
    trueValue: input.trueValue,
    trader: input.roles.trader,
    marketMaker: input.roles.marketMaker,
    traderPnL,
    marketMakerPnL: -traderPnL,
    forcedByTimeout: input.forcedByTimeout,
  };
}

/**
 * F-06: resolves what `settling` is waiting on (see PendingTradeDecision)
 * into the actual TradeSide to settle against. A trader's own EXECUTE_TRADE
 * passes straight through unchanged. A choosingSide clock expiry instead
 * forces whichever side is worse for the trader - BUY pays trueValue - ask,
 * SELL pays bid - trueValue (mirrors calculateSettlement's own PnL math) -
 * so that letting the clock run out can never beat acting, closing the
 * capped-downside exploit a flat forfeit penalty would otherwise leave open
 * once the trader has already seen the quote. Ties are resolved to BUY
 * deterministically rather than depending on floating point or iteration
 * order.
 */
export function resolvePendingTradeSide(
  pendingTrade: PendingTradeDecision,
  quote: Quote,
  trueValue: number,
): TradeSide {
  if (pendingTrade.kind === "chosen") {
    return pendingTrade.side;
  }

  const buyPnL = trueValue - quote.ask;
  const sellPnL = quote.bid - trueValue;

  return buyPnL <= sellPnL ? "BUY" : "SELL";
}

export function applySettlementToScores(
  scores: Scores,
  settlement: RoundSettlement,
): Scores {
  return {
    A:
      scores.A +
      (settlement.trader === "A" ? settlement.traderPnL : settlement.marketMakerPnL),
    B:
      scores.B +
      (settlement.trader === "B" ? settlement.traderPnL : settlement.marketMakerPnL),
  };
}

/**
 * Zero-sum like applySettlementToScores: the idle player's forfeit penalty
 * is deducted from them and credited to the opponent, never created or
 * destroyed.
 */
export function applyForfeitToScores(
  scores: Scores,
  forfeit: RoundForfeit,
): Scores {
  return {
    A: scores.A + (forfeit.forfeitedBy === "A" ? -forfeit.penalty : forfeit.penalty),
    B: scores.B + (forfeit.forfeitedBy === "B" ? -forfeit.penalty : forfeit.penalty),
  };
}
