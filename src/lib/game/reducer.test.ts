import { calculateSettlement } from "./settlement";
import {
  createInitialGameState,
  executeTrade,
  gameReducer,
  nextRound,
  receiveItem,
  receiveSettlement,
  resetGame,
  startGame,
  submitInitialWidth,
  submitMarketQuote,
  tightenWidth,
  tradeOnWidth,
} from "./index";
import type {
  GameAction,
  GameState,
  GeneratedItem,
  RoundSettlement,
  SettledGeneratedItem,
  StartGamePayload,
  TradeSide,
} from "./types";

const startPayload: StartGamePayload = {
  playerAName: "Ada",
  playerBName: "Grace",
  mode: "Chaos Quant",
  totalRounds: 2,
};

const item: GeneratedItem = {
  round_id: "round-1",
  item_title: "Seconds in a leap year",
  category: "Fermi Math & Geometry",
  context_clue: "A leap year has 366 days.",
};

function readyForWidth(): GameState {
  return receiveItem(startGame(createInitialGameState(), startPayload), item);
}

function readyForMarket(width = 200): GameState {
  const opened = submitInitialWidth(readyForWidth(), 500);
  const tightened = tightenWidth(opened, width);
  return tradeOnWidth(tightened);
}

function readyForSideChoice(quote = { bid: 31622100, ask: 31622300 }): GameState {
  return submitMarketQuote(readyForMarket(quote.ask - quote.bid), quote);
}

function serverSettlement(
  state: Extract<GameState, { phase: "settling" }>,
  trueValue = 31622400,
): {
  item: SettledGeneratedItem;
  settlement: RoundSettlement;
} {
  return {
    item: {
      ...state.item,
      true_value: trueValue,
    },
    settlement: calculateSettlement({
      roundNumber: state.roundNumber,
      itemTitle: state.item.item_title,
      trueValue,
      quote: state.quote,
      side: state.pendingSide,
      roles: state.roles,
    }),
  };
}

function settleTrade(
  state: GameState,
  side: TradeSide,
  trueValue = 31622400,
): GameState {
  const settling = executeTrade(state, side);
  expect(settling.phase).toBe("settling");

  if (settling.phase !== "settling") {
    throw new Error("Expected settling state.");
  }

  const { item: revealedItem, settlement } = serverSettlement(settling, trueValue);
  return receiveSettlement(settling, revealedItem, settlement);
}

describe("game reducer", () => {
  it("starts with player names, selected mode, round limit, and Player A as first width proposer", () => {
    const state = startGame(createInitialGameState(), startPayload);

    expect(state.phase).toBe("generatingItem");
    expect(state.players.A.name).toBe("Ada");
    expect(state.players.B.name).toBe("Grace");
    expect(state.mode).toBe("Chaos Quant");
    expect(state.totalRounds).toBe(2);
    expect(state.roles).toEqual({ marketMaker: "A", trader: "B" });
    expect(state.scores).toEqual({ A: 0, B: 0 });
  });

  it("leaves impossible phase actions unchanged", () => {
    const state = createInitialGameState();

    const nextState = gameReducer(state, { type: "EXECUTE_TRADE", side: "BUY" });

    expect(nextState).toBe(state);
  });

  it("guards non-reset actions outside their valid phases", () => {
    const setup = createInitialGameState();
    const generating = startGame(setup, startPayload);
    const proposing = receiveItem(generating, item);
    const negotiating = submitInitialWidth(proposing, 500);
    const configuring = tradeOnWidth(tightenWidth(negotiating, 200));
    const choosing = submitMarketQuote(configuring, { bid: 200, ask: 400 });
    const settling = executeTrade(choosing, "BUY");
    const settlement = settleTrade(choosing, "BUY", 300);
    const gameOver = nextRound(settlement);

    const settlementPayload =
      settling.phase === "settling" ? serverSettlement(settling, 300) : null;
    if (!settlementPayload) {
      throw new Error("Expected settling state.");
    }

    const invalidCases: Array<{ action: GameAction; state: GameState }> = [
      { state: generating, action: { type: "START_GAME", payload: startPayload } },
      { state: setup, action: { type: "ITEM_RECEIVED", item } },
      { state: setup, action: { type: "ITEM_FAILED", error: "no item" } },
      { state: setup, action: { type: "SUBMIT_INITIAL_WIDTH", width: 500 } },
      { state: setup, action: { type: "TIGHTEN_WIDTH", width: 200 } },
      { state: setup, action: { type: "TRADE_ON_WIDTH" } },
      { state: setup, action: { type: "SUBMIT_MARKET_QUOTE", quote: { bid: 1, ask: 2 } } },
      { state: setup, action: { type: "MARKET_COMMIT_FAILED", error: "failed" } },
      { state: setup, action: { type: "EXECUTE_TRADE", side: "SELL" } },
      {
        state: setup,
        action: {
          type: "SETTLEMENT_RECEIVED",
          item: settlementPayload.item,
          settlement: settlementPayload.settlement,
        },
      },
      { state: setup, action: { type: "SETTLEMENT_FAILED", error: "failed" } },
      { state: setup, action: { type: "NEXT_ROUND" } },
      { state: gameOver, action: { type: "EXECUTE_TRADE", side: "BUY" } },
    ];

    expect(proposing.phase).toBe("proposingWidth");
    expect(negotiating.phase).toBe("negotiatingWidth");
    expect(configuring.phase).toBe("configuringMarket");
    expect(choosing.phase).toBe("choosingSide");

    for (const { state, action } of invalidCases) {
      expect(gameReducer(state, action)).toBe(state);
    }

    expect(resetGame().phase).toBe("setup");
  });

  it("rejects invalid start payloads and keeps setup state", () => {
    const state = createInitialGameState();
    const nextState = startGame(state, {
      ...startPayload,
      playerAName: "   ",
    });

    expect(nextState.phase).toBe("setup");
    expect(nextState.lastError).toBe("Both player names are required.");
    expect(nextState.roundNumber).toBe(0);
  });

  it("validates the opening spread width before negotiation begins", () => {
    const nextState = submitInitialWidth(readyForWidth(), 0);

    expect(nextState.phase).toBe("proposingWidth");
    expect(nextState.lastError).toBe("Spread width must be greater than 0.");
  });

  it("tightens widths by swapping the active width owner and decision player", () => {
    const opened = submitInitialWidth(readyForWidth(), 500);
    const tightened = tightenWidth(opened, 200);

    expect(tightened.phase).toBe("negotiatingWidth");

    if (tightened.phase !== "negotiatingWidth") {
      throw new Error("Expected negotiating state.");
    }

    expect(tightened.spreadWidth).toBe(200);
    expect(tightened.roles).toEqual({ marketMaker: "B", trader: "A" });
  });

  it("rejects loose width attempts without swapping roles", () => {
    const opened = submitInitialWidth(readyForWidth(), 500);
    const rejected = tightenWidth(opened, 700);

    expect(rejected.phase).toBe("negotiatingWidth");
    expect(rejected.roles).toEqual({ marketMaker: "A", trader: "B" });
    expect(rejected.lastError).toBe("New spread width must be tighter than current width.");
  });

  it("lets the decision player trade on the latest width and makes the width owner set bid/ask", () => {
    const configuring = readyForMarket(200);

    expect(configuring.phase).toBe("configuringMarket");

    if (configuring.phase !== "configuringMarket") {
      throw new Error("Expected market configuration state.");
    }

    expect(configuring.spreadWidth).toBe(200);
    expect(configuring.roles).toEqual({ marketMaker: "B", trader: "A" });
  });

  it("validates the market quote against the accepted spread width", () => {
    const rejected = submitMarketQuote(readyForMarket(200), { bid: 100, ask: 250 });

    expect(rejected.phase).toBe("configuringMarket");
    expect(rejected.lastError).toBe("Bid and ask must match the accepted spread width.");
  });

  it("keeps players in market configuration after a failed market commit", () => {
    const configuring = readyForMarket(200);
    const failed = gameReducer(configuring, {
      type: "MARKET_COMMIT_FAILED",
      error: "Market could not be committed.",
    });

    expect(failed.phase).toBe("configuringMarket");
    expect(failed.roles).toEqual({ marketMaker: "B", trader: "A" });
    expect(failed.lastError).toBe("Market could not be committed.");
  });

  it("enters settling before receiving the server-revealed true value", () => {
    const quoted = readyForSideChoice();
    const settling = executeTrade(quoted, "BUY");

    expect(settling.phase).toBe("settling");

    if (settling.phase !== "settling") {
      throw new Error("Expected settling state.");
    }

    expect("true_value" in settling.item).toBe(false);
  });

  it("returns to side choice without revealing true value after failed settlement", () => {
    const choosing = readyForSideChoice({ bid: 200, ask: 400 });
    const settling = executeTrade(choosing, "BUY");
    const failed = gameReducer(settling, {
      type: "SETTLEMENT_FAILED",
      error: "Settlement failed.",
    });

    expect(failed.phase).toBe("choosingSide");

    if (failed.phase !== "choosingSide") {
      throw new Error("Expected side choice state.");
    }

    expect(failed.quote).toEqual({ bid: 200, ask: 400 });
    expect(failed.roles).toEqual({ marketMaker: "B", trader: "A" });
    expect("true_value" in failed.item).toBe(false);
    expect(failed.lastError).toBe("Settlement failed.");
  });

  it("settles the clarified A 500, B 200, A trades, B sets 200 / 400 flow", () => {
    const choosing = submitMarketQuote(readyForMarket(200), { bid: 200, ask: 400 });
    const settled = settleTrade(choosing, "BUY", 300);

    expect(settled.phase).toBe("settlement");

    if (settled.phase !== "settlement") {
      throw new Error("Expected settlement state.");
    }

    expect(settled.roles).toEqual({ marketMaker: "B", trader: "A" });
    expect(settled.item.true_value).toBe(300);
    expect(settled.settlement.transactionPrice).toBe(400);
    expect(settled.settlement.trader).toBe("A");
    expect(settled.settlement.marketMaker).toBe("B");
    expect(settled.settlement.traderPnL).toBe(-100);
    expect(settled.settlement.marketMakerPnL).toBe(100);
    expect(settled.scores).toEqual({ A: -100, B: 100 });
  });

  it("supports repeated width tightening and settles against the final active trader", () => {
    const opened = submitInitialWidth(readyForWidth(), 500);
    const firstTighten = tightenWidth(opened, 300);
    const secondTighten = tightenWidth(firstTighten, 100);
    const configuring = tradeOnWidth(secondTighten);
    const choosing = submitMarketQuote(configuring, { bid: 31622350, ask: 31622450 });
    const settled = settleTrade(choosing, "SELL");

    expect(settled.phase).toBe("settlement");

    if (settled.phase !== "settlement") {
      throw new Error("Expected settlement state.");
    }

    expect(settled.roles).toEqual({ marketMaker: "A", trader: "B" });
    expect(settled.settlement.trader).toBe("B");
    expect(settled.settlement.traderPnL).toBe(-50);
    expect(settled.settlement.marketMakerPnL).toBe(50);
    expect(settled.scores).toEqual({ A: 50, B: -50 });
  });

  it("moves to game over only after the configured final round and preserves zero-sum scores", () => {
    const firstSettlement = settleTrade(
      submitMarketQuote(readyForMarket(200), { bid: 200, ask: 400 }),
      "BUY",
      300,
    );
    const secondRound = nextRound(firstSettlement);

    expect(secondRound.phase).toBe("generatingItem");
    expect(secondRound.roundNumber).toBe(2);
    expect(secondRound.roles).toEqual({ marketMaker: "B", trader: "A" });

    const secondSettlement = settleTrade(
      submitMarketQuote(
        tradeOnWidth(
          submitInitialWidth(
            receiveItem(secondRound, { ...item, round_id: "round-2" }),
            100,
          ),
        ),
        { bid: 31622300, ask: 31622400 },
      ),
      "BUY",
    );
    const over = nextRound(secondSettlement);

    expect(over.phase).toBe("gameOver");

    if (over.phase !== "gameOver") {
      throw new Error("Expected game over state.");
    }

    expect(over.scores.A + over.scores.B).toBe(0);
    expect(over.winner).toBe("B");
  });

  it("swaps roles for Amazon custom query mode at game start and round transitions", () => {
    const customPayload: StartGamePayload = {
      playerAName: "Ada",
      playerBName: "Grace",
      mode: "Amazon",
      customAmazonQuery: true,
      totalRounds: 2,
    };

    // Start Game
    const state = startGame(createInitialGameState(), customPayload);
    expect(state.phase).toBe("generatingItem");
    // Roles are swapped from DEFAULT_ROLES ({ marketMaker: "A", trader: "B" })
    // to { marketMaker: "B", trader: "A" }
    expect(state.roles).toEqual({ marketMaker: "B", trader: "A" });

    // Simulate transitioning to Round 2
    const readyForSettle = submitMarketQuote(
      tradeOnWidth(
        submitInitialWidth(
          receiveItem(state, { ...item, round_id: "round-1" }),
          200,
        )
      ),
      { bid: 200, ask: 400 }
    );
    const settledRound = settleTrade(readyForSettle, "BUY", 300);
    const round2State = nextRound(settledRound);

    expect(round2State.phase).toBe("generatingItem");
    expect(round2State.roundNumber).toBe(2);
    // Roles for Round 2 normally are { marketMaker: "B", trader: "A" }
    // For Amazon Custom Query, it should be swapped to { marketMaker: "A", trader: "B" }
    expect(round2State.roles).toEqual({ marketMaker: "A", trader: "B" });
  });
});
