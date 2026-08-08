import { calculateSettlement } from "./settlement";
import {
  createInitialGameState,
  executeTrade,
  expireTurn,
  gameReducer,
  nextRound,
  receiveItem,
  receiveSettlement,
  resetGame,
  retryItemGeneration,
  startGame,
  submitInitialWidth,
  submitMarketQuote,
  tightenWidth,
  tradeOnWidth,
} from "./index";
import {
  PROPOSING_WIDTH_FORFEIT_PENALTY,
  type GameAction,
  type GameState,
  type GeneratedItem,
  type RoundSettlement,
  type SettledGeneratedItem,
  type StartGamePayload,
  type TradeSide,
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
      { state: setup, action: { type: "ITEM_RECEIVED", item, turnDeadlineMs: 0 } },
      { state: setup, action: { type: "ITEM_FAILED", error: "no item" } },
      { state: setup, action: { type: "RETRY_ITEM_GENERATION" } },
      { state: setup, action: { type: "SUBMIT_INITIAL_WIDTH", width: 500, turnDeadlineMs: 0 } },
      { state: setup, action: { type: "TIGHTEN_WIDTH", width: 200, turnDeadlineMs: 0 } },
      { state: setup, action: { type: "TRADE_ON_WIDTH", turnDeadlineMs: 0 } },
      {
        state: setup,
        action: { type: "SUBMIT_MARKET_QUOTE", quote: { bid: 1, ask: 2 }, turnDeadlineMs: 0 },
      },
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
      { state: setup, action: { type: "SETTLEMENT_FAILED", error: "failed", turnDeadlineMs: 0 } },
      { state: setup, action: { type: "TURN_EXPIRED" } },
      { state: settling, action: { type: "TURN_EXPIRED" } },
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

  it("returns to side choice without revealing true value after failed settlement, with a fresh turn deadline", () => {
    const choosing = readyForSideChoice({ bid: 200, ask: 400 });
    const settling = executeTrade(choosing, "BUY");
    const failed = gameReducer(settling, {
      type: "SETTLEMENT_FAILED",
      error: "Settlement failed.",
      turnDeadlineMs: 999,
    });

    expect(failed.phase).toBe("choosingSide");

    if (failed.phase !== "choosingSide") {
      throw new Error("Expected side choice state.");
    }

    expect(failed.quote).toEqual({ bid: 200, ask: 400 });
    expect(failed.roles).toEqual({ marketMaker: "B", trader: "A" });
    expect("true_value" in failed.item).toBe(false);
    expect("pendingSide" in failed).toBe(false);
    expect(failed.lastError).toBe("Settlement failed.");
    expect(failed.turnDeadlineMs).toBe(999);
  });

  it("retries item generation errors without dropping round context or log history", () => {
    const customPayload: StartGamePayload = {
      playerAName: "Ada",
      playerBName: "Grace",
      mode: "Amazon",
      customAmazonQuery: true,
      totalRounds: 2,
    };
    const generating = {
      ...startGame(createInitialGameState(), customPayload),
      scores: { A: 125, B: -125 },
    };
    const failed = gameReducer(generating, {
      type: "ITEM_FAILED",
      error: "Provider timed out.",
    });

    expect(failed.phase).toBe("error");

    if (failed.phase !== "error") {
      throw new Error("Expected item generation error state.");
    }

    const retried = retryItemGeneration(failed);

    expect(retried.phase).toBe("generatingItem");
    expect(retried.mode).toBe("Amazon");
    expect(retried.customAmazonQuery).toBe(true);
    expect(retried.players).toEqual(generating.players);
    expect(retried.scores).toEqual({ A: 125, B: -125 });
    expect(retried.roles).toEqual(generating.roles);
    expect(retried.roundNumber).toBe(generating.roundNumber);
    expect(retried.totalRounds).toBe(generating.totalRounds);
    expect(retried.lastError).toBeUndefined();
    expect("error" in retried).toBe(false);
    expect("previousPhase" in retried).toBe(false);
    expect(retried.log.slice(0, -1)).toEqual(failed.log);
    expect(retried.log[retried.log.length - 1]).toMatchObject({
      phase: "generatingItem",
      message: "Retrying item generation for round 1.",
    });
  });

  it("does not retry non-item-generation error states", () => {
    const choosing = readyForSideChoice({ bid: 200, ask: 400 });
    const settling = executeTrade(choosing, "BUY");
    const failed = gameReducer(settling, {
      type: "SETTLEMENT_FAILED",
      error: "Settlement failed.",
      turnDeadlineMs: 999,
    });
    const nonItemError: GameState = {
      ...failed,
      phase: "error",
      error: "Market commit failed.",
      previousPhase: "configuringMarket",
      lastError: "Market commit failed.",
    };

    expect(retryItemGeneration(nonItemError)).toBe(nonItemError);
  });

  it("leaves a settling room untouched (F-02 recovery is a room/Worker-layer concern, not a reducer transition)", () => {
    // Retrying a room stuck in `settling` re-runs the settlement effect
    // against the unchanged item/quote/pendingSide; it does not go through
    // RETRY_ITEM_GENERATION or any other reducer action. This pins that the
    // reducer has no case for retrying out of `settling`, so a future
    // reducer change can't accidentally let this action mutate settling
    // state (e.g. resetting pendingSide) and undermine settlement
    // determinism.
    const choosing = readyForSideChoice({ bid: 200, ask: 400 });
    const settling = executeTrade(choosing, "BUY");

    expect(settling.phase).toBe("settling");
    expect(gameReducer(settling, { type: "RETRY_ITEM_GENERATION" })).toBe(settling);
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

  describe("F-05 turn shot clock", () => {
    it("forfeits the round on turn expiry and applies the zero-sum penalty against the width in play", () => {
      // negotiatingWidth: the trader (B by default) is on the clock.
      const negotiating = submitInitialWidth(readyForWidth(), 500);
      const expired = expireTurn(negotiating);

      expect(expired.phase).toBe("roundForfeited");

      if (expired.phase !== "roundForfeited") {
        throw new Error("Expected roundForfeited state.");
      }
      expect(expired.forfeit).toMatchObject({
        roundNumber: 1,
        itemTitle: item.item_title,
        phase: "negotiatingWidth",
        forfeitedBy: "B",
        awardedTo: "A",
        penalty: 500,
      });
      expect(expired.scores).toEqual({ A: 500, B: -500 });
    });

    it("forfeits proposingWidth using the named fallback penalty since no width has been proposed yet", () => {
      // proposingWidth: the market maker (A by default) is on the clock.
      const proposing = readyForWidth();
      const expired = expireTurn(proposing);

      expect(expired.phase).toBe("roundForfeited");

      if (expired.phase !== "roundForfeited") {
        throw new Error("Expected roundForfeited state.");
      }
      expect(expired.forfeit).toMatchObject({
        phase: "proposingWidth",
        forfeitedBy: "A",
        awardedTo: "B",
        penalty: PROPOSING_WIDTH_FORFEIT_PENALTY,
      });
      expect(expired.scores).toEqual({
        A: -PROPOSING_WIDTH_FORFEIT_PENALTY,
        B: PROPOSING_WIDTH_FORFEIT_PENALTY,
      });
    });

    it("forfeits configuringMarket and choosingSide against whichever player is on the clock there", () => {
      const configuring = tradeOnWidth(tightenWidth(submitInitialWidth(readyForWidth(), 500), 200));
      const expiredMarket = expireTurn(configuring);

      expect(expiredMarket.phase).toBe("roundForfeited");
      if (expiredMarket.phase !== "roundForfeited") {
        throw new Error("Expected roundForfeited state.");
      }
      // negotiatingWidth's TIGHTEN_WIDTH swapped roles, so B is now
      // marketMaker and on the clock in configuringMarket.
      expect(expiredMarket.forfeit).toMatchObject({
        phase: "configuringMarket",
        forfeitedBy: "B",
        awardedTo: "A",
        penalty: 200,
      });

      const choosing = submitMarketQuote(configuring, { bid: 100, ask: 300 });
      const expiredSide = expireTurn(choosing);

      expect(expiredSide.phase).toBe("roundForfeited");
      if (expiredSide.phase !== "roundForfeited") {
        throw new Error("Expected roundForfeited state.");
      }
      // choosingSide waits on the trader, which is A after the tighten swap.
      expect(expiredSide.forfeit).toMatchObject({
        phase: "choosingSide",
        forfeitedBy: "A",
        awardedTo: "B",
        penalty: 200,
      });
    });

    it("rejects TURN_EXPIRED outside the four actionable phases, leaving state untouched", () => {
      const singleRoundPayload: StartGamePayload = { ...startPayload, totalRounds: 1 };
      const setup = createInitialGameState();
      const generating = startGame(setup, singleRoundPayload);
      const choosing = readyForSideChoice({ bid: 200, ask: 400 });
      const settling = executeTrade(choosing, "BUY");
      const settlement = settleTrade(
        submitMarketQuote(
          tradeOnWidth(submitInitialWidth(receiveItem(generating, item), 200)),
          { bid: 200, ask: 400 },
        ),
        "BUY",
        300,
      );
      const gameOver = nextRound(settlement);

      expect(gameOver.phase).toBe("gameOver");

      for (const state of [setup, generating, settling, settlement, gameOver]) {
        expect(gameReducer(state, { type: "TURN_EXPIRED" })).toBe(state);
      }
    });

    it("advances from a round forfeit exactly like from settlement, including to game over on the final round", () => {
      const singleRoundPayload: StartGamePayload = { ...startPayload, totalRounds: 1 };
      const proposing = receiveItem(startGame(createInitialGameState(), singleRoundPayload), item);
      const forfeited = expireTurn(proposing);

      expect(forfeited.phase).toBe("roundForfeited");

      const over = nextRound(forfeited);

      expect(over.phase).toBe("gameOver");

      if (over.phase !== "gameOver") {
        throw new Error("Expected game over state.");
      }
      expect(over.scores.A + over.scores.B).toBe(0);
      expect(over.winner).toBe("B");
    });

    it("advances a round forfeit into the next round (not final) with fresh roles", () => {
      const proposing = readyForWidth();
      const forfeited = expireTurn(proposing);
      const round2 = nextRound(forfeited);

      expect(round2.phase).toBe("generatingItem");
      expect(round2.roundNumber).toBe(2);
      expect(round2.roles).toEqual({ marketMaker: "B", trader: "A" });
    });
  });
});
