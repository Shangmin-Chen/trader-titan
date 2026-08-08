import type { Quote, Roles, RoundForfeit, RoundSettlement, Scores, TradeSide } from "./types";

type SettlementInput = {
  roundNumber: number;
  itemTitle: string;
  trueValue: number;
  quote: Quote;
  side: TradeSide;
  roles: Roles;
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
  };
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
