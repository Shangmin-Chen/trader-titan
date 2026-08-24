import { calculateSettlement, resolvePendingTradeSide } from "./settlement";
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
  SETTLEMENT_FAILURE_EPISODE_CAP,
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
  const side = resolvePendingTradeSide(state.pendingTrade, state.quote, trueValue);

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
      side,
      roles: state.roles,
      forcedByTimeout: state.pendingTrade.kind === "timeoutForcedWorstSide",
    }),
  };
}

function toSideChoiceFromGeneratingItem(
  state: Extract<GameState, { phase: "generatingItem" }>,
  roundId: string,
  quote: { bid: number; ask: number },
): GameState {
  const withItem = receiveItem(state, { ...item, round_id: roundId });
  const opened = submitInitialWidth(withItem, 500);
  const tightened = tightenWidth(opened, quote.ask - quote.bid);
  const traded = tradeOnWidth(tightened);
  return submitMarketQuote(traded, quote);
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

  it("EXECUTE_TRADE's own settling transition drops turnDeadlineMs, just like the F-06 timeout path does", () => {
    // Mirrors the F-06 "drops turnDeadlineMs" assertion below for the
    // timeout-forced transition into settling: that test alone left this
    // ordinary (trader actually chose a side) transition unguarded, and
    // reintroducing `...state` on EXECUTE_TRADE's own case (see the
    // reducer's "Deliberately not `...state`" comment) typechecks clean and
    // passes every other unit test, since TS does not flag excess
    // properties introduced via spread.
    const choosing = readyForSideChoice({ bid: 200, ask: 400 });
    const settling = executeTrade(choosing, "BUY");

    expect(settling.phase).toBe("settling");

    if (settling.phase !== "settling") {
      throw new Error("Expected settling state.");
    }

    expect(settling.pendingTrade).toEqual({ kind: "chosen", side: "BUY" });
    expect("turnDeadlineMs" in settling).toBe(false);
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

  it("returns to side choice without revealing true value after failed settlement, with a fresh turn deadline, locking the pending trade forward", () => {
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
    // The regression this branch exists to prevent: the pendingTrade that
    // was already in flight (a trader's own EXECUTE_TRADE choice, here) must
    // not be silently discarded on a settlement bounce-back - see
    // lockedPendingTrade's doc comment on ChoosingSideGameState.
    expect(failed.lockedPendingTrade).toEqual({ kind: "chosen", side: "BUY" });
  });

  describe("SETTLEMENT_FAILED locks the pending trade decision against re-choice (C1 regression)", () => {
    it("carries an F-06 timeoutForcedWorstSide decision forward as a locked marker rather than dropping it", () => {
      // trueValue 3600, quote 3600/3800: BUY is the worse side for the
      // trader (buyPnL -200 < sellPnL 0) - see the identical fixture in the
      // "settles a choosingSide timeout against BUY..." F-06 tests below.
      const choosing = readyForSideChoice({ bid: 3600, ask: 3800 });
      const settling = expireTurn(choosing);

      expect(settling.phase).toBe("settling");

      if (settling.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      expect(settling.pendingTrade).toEqual({ kind: "timeoutForcedWorstSide" });

      const failed = gameReducer(settling, {
        type: "SETTLEMENT_FAILED",
        error: "Settlement failed.",
        turnDeadlineMs: 999,
      });

      expect(failed.phase).toBe("choosingSide");

      if (failed.phase !== "choosingSide") {
        throw new Error("Expected side choice state.");
      }

      expect(failed.lockedPendingTrade).toEqual({ kind: "timeoutForcedWorstSide" });
    });

    it("BUG this pins: EXECUTE_TRADE on a locked choosingSide ignores the requested side and re-enters settling with the locked decision instead", () => {
      // The exploit a86745a closed: a trader whose clock expiry forced BUY
      // (the worse side for them) must not be able to escape it by
      // re-choosing SELL just because settlement happened to fail once and
      // bounce the round back through choosingSide.
      const choosing = readyForSideChoice({ bid: 3600, ask: 3800 });
      const timedOut = expireTurn(choosing);
      const failed = gameReducer(timedOut, {
        type: "SETTLEMENT_FAILED",
        error: "Settlement failed.",
        turnDeadlineMs: 999,
      });

      expect(failed.phase).toBe("choosingSide");

      if (failed.phase !== "choosingSide") {
        throw new Error("Expected side choice state.");
      }

      expect(failed.lockedPendingTrade).toEqual({ kind: "timeoutForcedWorstSide" });

      // The trader (or their client) tries to claw back the better side.
      const retried = executeTrade(failed, "SELL");

      expect(retried.phase).toBe("settling");

      if (retried.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      // Must still be the locked, forced decision - NOT { kind: "chosen",
      // side: "SELL" }. Reverting SETTLEMENT_FAILED to drop the locked
      // marker (the pre-fix behavior) makes this assertion fail: the
      // resulting pendingTrade would be the trader's freely re-chosen SELL.
      expect(retried.pendingTrade).toEqual({ kind: "timeoutForcedWorstSide" });

      const { item: revealedItem, settlement } = serverSettlement(retried, 3600);
      const settled = receiveSettlement(retried, revealedItem, settlement);

      expect(settled.phase).toBe("settlement");

      if (settled.phase !== "settlement") {
        throw new Error("Expected settlement state.");
      }

      // BUY is still the side actually settled against, exactly as F-06
      // requires - not the SELL the trader tried to re-choose.
      expect(settled.settlement.side).toBe("BUY");
      expect(settled.settlement.traderPnL).toBe(-200);
      expect(settled.settlement.forcedByTimeout).toBe(true);
    });

    it("also locks a trader's own 'chosen' decision: a re-EXECUTE_TRADE with a different side does not override it", () => {
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

      const retried = executeTrade(failed, "SELL");

      expect(retried.phase).toBe("settling");

      if (retried.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      expect(retried.pendingTrade).toEqual({ kind: "chosen", side: "BUY" });
    });

    it("TURN_EXPIRED on a locked choosingSide re-enters settling with the same locked decision rather than resetting it", () => {
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

      // The trader does nothing this time and the clock (now measuring
      // time until an automatic retry, not a live choice) runs out again.
      const reExpired = expireTurn(failed);

      expect(reExpired.phase).toBe("settling");

      if (reExpired.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      // Must stay the trader's own locked "chosen" BUY, not get reset to
      // the generic "timeoutForcedWorstSide" sentinel a plain (unlocked)
      // choosingSide expiry would produce.
      expect(reExpired.pendingTrade).toEqual({ kind: "chosen", side: "BUY" });

      // F-07: the clock-expiry path into settling must carry
      // settlementFailureCount forward exactly like EXECUTE_TRADE's retry
      // path does (see settlingStateFromChoosingSideTimeout). `failed` already
      // recorded one SETTLEMENT_FAILED, so a fresh clock expiry re-entering
      // settling without going through EXECUTE_TRADE must still show that 1,
      // not silently reset it to 0 - otherwise a distracted or disconnected
      // trader who always times out instead of manually retrying would never
      // count toward SETTLEMENT_FAILURE_EPISODE_CAP and the bounce this PR
      // caps could cycle indefinitely through this door instead.
      expect(reExpired.settlementFailureCount).toBe(1);
    });

    it("a plain (unlocked) choosingSide has no lockedPendingTrade field at all", () => {
      const choosing = readyForSideChoice({ bid: 200, ask: 400 });

      expect(choosing.phase).toBe("choosingSide");
      expect("lockedPendingTrade" in choosing).toBe(false);
    });
  });

  describe("F-07 bounds SETTLEMENT_FAILED bounces across settling episodes", () => {
    it("starts a round's first settling episode with settlementFailureCount 0", () => {
      const choosing = readyForSideChoice({ bid: 200, ask: 400 });
      const settling = executeTrade(choosing, "BUY");

      expect(settling.phase).toBe("settling");

      if (settling.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      expect(settling.settlementFailureCount).toBe(0);
    });

    it("increments settlementFailureCount across separate settling episodes rather than resetting each bounce", () => {
      const choosing = readyForSideChoice({ bid: 200, ask: 400 });
      const settlingEpisode1 = executeTrade(choosing, "BUY");

      expect(settlingEpisode1.phase).toBe("settling");

      if (settlingEpisode1.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      expect(settlingEpisode1.settlementFailureCount).toBe(0);

      const failedOnce = gameReducer(settlingEpisode1, {
        type: "SETTLEMENT_FAILED",
        error: "attempt 1 failed",
        turnDeadlineMs: 1,
      });

      expect(failedOnce.phase).toBe("choosingSide");

      if (failedOnce.phase !== "choosingSide") {
        throw new Error("Expected side choice state.");
      }

      expect(failedOnce.settlementFailureCount).toBe(1);

      // Retrying re-enters `settling` for a second episode. The count this
      // episode starts with is the load-bearing assertion here: it must
      // carry the 1 failure forward, not reset to a fresh 0 the way episode
      // 1 started - a fresh-per-episode counter would never reach the cap
      // no matter how many times the round bounces.
      const settlingEpisode2 = executeTrade(failedOnce, "SELL");

      expect(settlingEpisode2.phase).toBe("settling");

      if (settlingEpisode2.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      expect(settlingEpisode2.settlementFailureCount).toBe(1);

      const failedTwice = gameReducer(settlingEpisode2, {
        type: "SETTLEMENT_FAILED",
        error: "attempt 2 failed",
        turnDeadlineMs: 2,
      });

      expect(failedTwice.phase).toBe("choosingSide");

      if (failedTwice.phase !== "choosingSide") {
        throw new Error("Expected side choice state.");
      }

      expect(failedTwice.settlementFailureCount).toBe(2);
    });

    it("reaches the terminal error phase exactly at SETTLEMENT_FAILURE_EPISODE_CAP failures, not one bounce early or late", () => {
      const choosing = readyForSideChoice({ bid: 200, ask: 400 });
      let state: GameState = executeTrade(choosing, "BUY");

      // Every failure before the cap-th must still bounce back to a locked
      // choosingSide, carrying the count forward for the next episode.
      for (let attempt = 1; attempt < SETTLEMENT_FAILURE_EPISODE_CAP; attempt += 1) {
        expect(state.phase).toBe("settling");

        if (state.phase !== "settling") {
          throw new Error("Expected settling state.");
        }

        expect(state.settlementFailureCount).toBe(attempt - 1);

        const failed = gameReducer(state, {
          type: "SETTLEMENT_FAILED",
          error: `attempt ${attempt} failed`,
          turnDeadlineMs: attempt,
        });

        expect(failed.phase).toBe("choosingSide");

        if (failed.phase !== "choosingSide") {
          throw new Error("Expected side choice state.");
        }

        expect(failed.settlementFailureCount).toBe(attempt);

        state = executeTrade(failed, "BUY");
      }

      expect(state.phase).toBe("settling");

      if (state.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      expect(state.settlementFailureCount).toBe(SETTLEMENT_FAILURE_EPISODE_CAP - 1);

      // The cap-th failure - and only the cap-th - must be terminal.
      const terminal = gameReducer(state, {
        type: "SETTLEMENT_FAILED",
        error: "final failure",
        turnDeadlineMs: 999,
      });

      expect(terminal.phase).toBe("error");

      if (terminal.phase !== "error") {
        throw new Error("Expected terminal error state.");
      }

      expect(terminal.previousPhase).toBe("settling");
      expect(terminal.error).toBe("final failure");
      expect(terminal.lastError).toBe("final failure");
      // A permanently failed settlement has no RoundSettlement and no
      // revealed true_value, and cannot be turn-clocked (so no further
      // alarm can be armed from it) - the `error` phase structurally
      // cannot carry any of these fields.
      expect("lockedPendingTrade" in terminal).toBe(false);
      expect("settlementFailureCount" in terminal).toBe(false);
      expect("turnDeadlineMs" in terminal).toBe(false);
      expect("item" in terminal).toBe(false);
      expect("settlement" in terminal).toBe(false);
    });

    it("a fresh round does not inherit a stale settlementFailureCount from an earlier round's bounce", () => {
      const choosing = readyForSideChoice({ bid: 500, ask: 700 });
      const settlingRound1 = executeTrade(choosing, "BUY");

      if (settlingRound1.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      const failedRound1 = gameReducer(settlingRound1, {
        type: "SETTLEMENT_FAILED",
        error: "transient",
        turnDeadlineMs: 1,
      });

      if (failedRound1.phase !== "choosingSide") {
        throw new Error("Expected side choice state.");
      }

      expect(failedRound1.settlementFailureCount).toBe(1);

      const retriedRound1 = executeTrade(failedRound1, "BUY");

      if (retriedRound1.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      // This time settlement actually succeeds.
      const { item: revealedItem, settlement } = serverSettlement(retriedRound1, 650);
      const settledRound1 = receiveSettlement(retriedRound1, revealedItem, settlement);

      expect(settledRound1.phase).toBe("settlement");
      expect("settlementFailureCount" in settledRound1).toBe(false);

      const generatingRound2 = nextRound(settledRound1);

      expect(generatingRound2.phase).toBe("generatingItem");
      expect(generatingRound2.roundNumber).toBe(2);
      expect("settlementFailureCount" in generatingRound2).toBe(false);

      if (generatingRound2.phase !== "generatingItem") {
        throw new Error("Expected generatingItem state.");
      }

      const choosingRound2 = toSideChoiceFromGeneratingItem(
        generatingRound2,
        "round-2",
        { bid: 500, ask: 700 },
      );

      expect(choosingRound2.phase).toBe("choosingSide");
      expect("lockedPendingTrade" in choosingRound2).toBe(false);
      expect("settlementFailureCount" in choosingRound2).toBe(false);

      const settlingRound2 = executeTrade(choosingRound2, "BUY");

      expect(settlingRound2.phase).toBe("settling");

      if (settlingRound2.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      // The key assertion: round 2's very first settling episode starts
      // back at 0, not at round 1's leftover count of 1.
      expect(settlingRound2.settlementFailureCount).toBe(0);
    });
  });

  it("retries item generation errors without dropping round context or log history", () => {
    const customPayload: StartGamePayload = {
      playerAName: "Ada",
      playerBName: "Grace",
      mode: "Cosmic Scale",
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
    expect(retried.mode).toBe("Cosmic Scale");
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

  it("keeps the rolesForRound calendar uniform at game start and round transitions (D5)", () => {
    const payload: StartGamePayload = {
      playerAName: "Ada",
      playerBName: "Grace",
      mode: "Cosmic Scale",
      totalRounds: 2,
    };

    // Start Game: Player A proposes width in odd rounds.
    const state = startGame(createInitialGameState(), payload);
    expect(state.phase).toBe("generatingItem");
    expect(state.roles).toEqual({ marketMaker: "A", trader: "B" });

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
    // Roles for Round 2 are { marketMaker: "B", trader: "A" }: the uniform
    // rolesForRound calendar, with no per-mode role swap.
    expect(round2State.roles).toEqual({ marketMaker: "B", trader: "A" });
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

    it("forfeits configuringMarket against whichever player is on the clock there", () => {
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

  describe("F-06 choosingSide timeout forces worst-side settlement", () => {
    it("moves a choosingSide timeout straight to settling with an unresolved pendingTrade instead of forfeiting, and drops turnDeadlineMs", () => {
      const choosing = readyForSideChoice({ bid: 200, ask: 400 });
      const settling = expireTurn(choosing);

      expect(settling.phase).toBe("settling");

      if (settling.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      // Not a forfeit: choosingSide's clock expiring must not short-circuit
      // to roundForfeited any more (see the "forfeits configuringMarket..."
      // test above for the phases that still do).
      expect(settling.pendingTrade).toEqual({ kind: "timeoutForcedWorstSide" });
      expect(settling.quote).toEqual({ bid: 200, ask: 400 });
      expect("true_value" in settling.item).toBe(false);
      // Mirrors EXECUTE_TRADE's own settling transition: settling is not a
      // turn-clocked phase, so it must not carry a stray turnDeadlineMs.
      expect("turnDeadlineMs" in settling).toBe(false);
    });

    it("settles against BUY when BUY is the worse side for the trader", () => {
      // trueValue 3600, quote 3600/3800: buyPnL = 3600-3800 = -200,
      // sellPnL = 3600-3600 = 0. BUY is worse.
      const choosing = readyForSideChoice({ bid: 3600, ask: 3800 });
      const settling = expireTurn(choosing);

      expect(settling.phase).toBe("settling");

      if (settling.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      const { item: revealedItem, settlement } = serverSettlement(settling, 3600);
      const settled = receiveSettlement(settling, revealedItem, settlement);

      expect(settled.phase).toBe("settlement");

      if (settled.phase !== "settlement") {
        throw new Error("Expected settlement state.");
      }
      expect(settled.settlement.side).toBe("BUY");
      expect(settled.settlement.traderPnL).toBe(-200);
      expect(settled.settlement.forcedByTimeout).toBe(true);
      expect(settled.log.at(-1)?.message).toContain("ran out of time");
    });

    it("settles against SELL when SELL is the worse side for the trader", () => {
      // trueValue 3600, quote 3300/3500: buyPnL = 3600-3500 = 100,
      // sellPnL = 3300-3600 = -300. SELL is worse.
      const choosing = readyForSideChoice({ bid: 3300, ask: 3500 });
      const settling = expireTurn(choosing);

      expect(settling.phase).toBe("settling");

      if (settling.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      const { item: revealedItem, settlement } = serverSettlement(settling, 3600);
      const settled = receiveSettlement(settling, revealedItem, settlement);

      expect(settled.phase).toBe("settlement");

      if (settled.phase !== "settlement") {
        throw new Error("Expected settlement state.");
      }
      expect(settled.settlement.side).toBe("SELL");
      expect(settled.settlement.traderPnL).toBe(-300);
      expect(settled.settlement.forcedByTimeout).toBe(true);
    });

    it("breaks an exact PnL tie by deterministically forcing BUY", () => {
      // trueValue 3600, quote 3500/3700: buyPnL = 3600-3700 = -100,
      // sellPnL = 3500-3600 = -100. Tied.
      const choosing = readyForSideChoice({ bid: 3500, ask: 3700 });
      const settling = expireTurn(choosing);

      expect(settling.phase).toBe("settling");

      if (settling.phase !== "settling") {
        throw new Error("Expected settling state.");
      }

      const { item: revealedItem, settlement } = serverSettlement(settling, 3600);
      const settled = receiveSettlement(settling, revealedItem, settlement);

      expect(settled.phase).toBe("settlement");

      if (settled.phase !== "settlement") {
        throw new Error("Expected settlement state.");
      }
      expect(settled.settlement.side).toBe("BUY");
      expect(settled.settlement.traderPnL).toBe(-100);
    });

    it("does not treat a trader's own EXECUTE_TRADE as forced", () => {
      const choosing = readyForSideChoice({ bid: 200, ask: 400 });
      const settled = settleTrade(choosing, "BUY", 300);

      expect(settled.phase).toBe("settlement");

      if (settled.phase !== "settlement") {
        throw new Error("Expected settlement state.");
      }
      expect(settled.settlement.forcedByTimeout).toBe(false);
    });
  });
});
