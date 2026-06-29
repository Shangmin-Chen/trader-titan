import { applySettlementToScores, calculateSettlement } from "./settlement";

describe("settlement", () => {
  it("calculates BUY trades exactly and zero-sum", () => {
    const settlement = calculateSettlement({
      roundNumber: 1,
      itemTitle: "Test Item",
      trueValue: 150,
      quote: { bid: 100, ask: 140 },
      side: "BUY",
      roles: { marketMaker: "A", trader: "B" },
    });

    expect(settlement.transactionPrice).toBe(140);
    expect(settlement.traderPnL).toBe(10);
    expect(settlement.marketMakerPnL).toBe(-10);
    expect(settlement.traderPnL + settlement.marketMakerPnL).toBe(0);
    expect(applySettlementToScores({ A: 3, B: 7 }, settlement)).toEqual({
      A: -7,
      B: 17,
    });
  });

  it("calculates SELL trades exactly and zero-sum", () => {
    const settlement = calculateSettlement({
      roundNumber: 2,
      itemTitle: "Test Item",
      trueValue: 92,
      quote: { bid: 100, ask: 140 },
      side: "SELL",
      roles: { marketMaker: "B", trader: "A" },
    });

    expect(settlement.transactionPrice).toBe(100);
    expect(settlement.traderPnL).toBe(8);
    expect(settlement.marketMakerPnL).toBe(-8);
    expect(settlement.traderPnL + settlement.marketMakerPnL).toBe(0);
    expect(applySettlementToScores({ A: 0, B: 0 }, settlement)).toEqual({
      A: 8,
      B: -8,
    });
  });
});
