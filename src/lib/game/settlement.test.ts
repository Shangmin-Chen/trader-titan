import {
  applySettlementToScores,
  calculateSettlement,
  resolvePendingTradeSide,
} from "./settlement";

describe("settlement", () => {
  it("calculates BUY trades exactly and zero-sum", () => {
    const settlement = calculateSettlement({
      roundNumber: 1,
      itemTitle: "Test Item",
      trueValue: 150,
      quote: { bid: 100, ask: 140 },
      side: "BUY",
      roles: { marketMaker: "A", trader: "B" },
      forcedByTimeout: false,
    });

    expect(settlement.transactionPrice).toBe(140);
    expect(settlement.traderPnL).toBe(10);
    expect(settlement.marketMakerPnL).toBe(-10);
    expect(settlement.traderPnL + settlement.marketMakerPnL).toBe(0);
    expect(settlement.forcedByTimeout).toBe(false);
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
      forcedByTimeout: false,
    });

    expect(settlement.transactionPrice).toBe(100);
    expect(settlement.traderPnL).toBe(8);
    expect(settlement.marketMakerPnL).toBe(-8);
    expect(settlement.traderPnL + settlement.marketMakerPnL).toBe(0);
    expect(settlement.forcedByTimeout).toBe(false);
    expect(applySettlementToScores({ A: 0, B: 0 }, settlement)).toEqual({
      A: 8,
      B: -8,
    });
  });

  it("records forcedByTimeout on the resulting settlement when set", () => {
    const settlement = calculateSettlement({
      roundNumber: 3,
      itemTitle: "Test Item",
      trueValue: 100,
      quote: { bid: 90, ask: 110 },
      side: "BUY",
      roles: { marketMaker: "A", trader: "B" },
      forcedByTimeout: true,
    });

    expect(settlement.forcedByTimeout).toBe(true);
  });

  describe("resolvePendingTradeSide (F-06)", () => {
    it("passes a chosen trade's side through unchanged", () => {
      expect(
        resolvePendingTradeSide(
          { kind: "chosen", side: "SELL" },
          { bid: 90, ask: 110 },
          100,
        ),
      ).toBe("SELL");
      expect(
        resolvePendingTradeSide(
          { kind: "chosen", side: "BUY" },
          { bid: 90, ask: 110 },
          100,
        ),
      ).toBe("BUY");
    });

    it("forces BUY when it is the worse side for the trader", () => {
      // trueValue 3600, quote 3600/3800: buyPnL = 3600-3800 = -200,
      // sellPnL = 3600-3600 = 0. BUY is worse, so a stalling trader is
      // forced into it rather than the breakeven SELL.
      const side = resolvePendingTradeSide(
        { kind: "timeoutForcedWorstSide" },
        { bid: 3600, ask: 3800 },
        3600,
      );

      expect(side).toBe("BUY");
    });

    it("forces SELL when it is the worse side for the trader", () => {
      // trueValue 3600, quote 3300/3500: buyPnL = 3600-3500 = 100,
      // sellPnL = 3300-3600 = -300. SELL is worse.
      const side = resolvePendingTradeSide(
        { kind: "timeoutForcedWorstSide" },
        { bid: 3300, ask: 3500 },
        3600,
      );

      expect(side).toBe("SELL");
    });

    it("breaks an exact PnL tie by deterministically forcing BUY", () => {
      // trueValue 3600, quote 3500/3700: buyPnL = 3600-3700 = -100,
      // sellPnL = 3500-3600 = -100. Tied.
      const side = resolvePendingTradeSide(
        { kind: "timeoutForcedWorstSide" },
        { bid: 3500, ask: 3700 },
        3600,
      );

      expect(side).toBe("BUY");
    });
  });
});
