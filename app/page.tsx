"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import {
  ActionLog,
  CustomAmazonQueryForm,
  GameShell,
  ItemPanel,
  MarketRangeForm,
  Scoreboard,
  SettlementPanel,
  SetupForm,
  SpreadWidthForm,
  TradeActionPanel,
  WidthNegotiationPanel,
} from "../src/components";
import {
  createInitialGameState,
  formatSignedNumber,
  gameReducer,
  toPublicItem,
  type GeneratedItem,
  type Quote,
  type RoundSettlement,
  type SettledGeneratedItem,
  type StartGamePayload,
} from "../src/lib/game";

type ApiErrorResponse = {
  error?: string;
};

type SettlementResponse = {
  item: SettledGeneratedItem;
  settlement: RoundSettlement;
};

export default function Home() {
  const [state, dispatch] = useReducer(gameReducer, undefined, () =>
    createInitialGameState(),
  );
  const activeRequest = useRef<AbortController | null>(null);
  const commitInFlight = useRef(false);
  const [isCommittingMarket, setIsCommittingMarket] = useState(false);
  const [isGeneratingCustomItem, setIsGeneratingCustomItem] = useState(false);

  async function handleCustomAmazonQuerySubmit(query: string) {
    setIsGeneratingCustomItem(true);
    try {
      const response = await fetch("/api/generate-custom-amazon-item", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiErrorResponse;
        throw new Error(body.error ?? "Failed to submit Amazon query.");
      }

      const item = (await response.json()) as GeneratedItem;
      dispatch({ type: "ITEM_RECEIVED", item });
    } catch (error) {
      dispatch({
        type: "ITEM_FAILED",
        error: error instanceof Error ? error.message : "Failed to submit Amazon query.",
      });
    } finally {
      setIsGeneratingCustomItem(false);
    }
  }

  useEffect(() => {
    if (state.phase !== "generatingItem" || (state.mode === "Amazon" && state.customAmazonQuery === true)) {
      return;
    }

    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;

    async function generateItem() {
      try {
        const response = await fetch("/api/generate-item", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: state.mode }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as ApiErrorResponse;
          throw new Error(body.error ?? "Item generation failed.");
        }

        const item = (await response.json()) as GeneratedItem;
        dispatch({ type: "ITEM_RECEIVED", item });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        dispatch({
          type: "ITEM_FAILED",
          error:
            error instanceof Error
              ? error.message
              : "Item generation failed.",
        });
      }
    }

    void generateItem();

    return () => {
      controller.abort();
    };
  }, [state.mode, state.phase, state.roundNumber, state.customAmazonQuery]);

  useEffect(() => {
    if (state.phase !== "settling") {
      return;
    }

    const settlingState = state;
    const controller = new AbortController();

    async function settleRound() {
      try {
        const response = await fetch("/api/settle-round", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            round_id: settlingState.item.round_id,
            side: settlingState.pendingSide,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as ApiErrorResponse;
          throw new Error(body.error ?? "Settlement failed.");
        }

        const body = (await response.json()) as SettlementResponse;
        dispatch({
          type: "SETTLEMENT_RECEIVED",
          item: body.item,
          settlement: body.settlement,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        dispatch({
          type: "SETTLEMENT_FAILED",
          error:
            error instanceof Error
              ? error.message
              : "Settlement failed.",
        });
      }
    }

    void settleRound();

    return () => {
      controller.abort();
    };
  }, [state]);

  function handleStart(payload: StartGamePayload) {
    dispatch({ type: "START_GAME", payload });
  }

  async function commitMarket(quote: Quote) {
    if (state.phase !== "configuringMarket" || commitInFlight.current) {
      return false;
    }

    commitInFlight.current = true;
    setIsCommittingMarket(true);

    try {
      const response = await fetch("/api/commit-market", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quote,
          roles: state.roles,
          round_id: state.item.round_id,
          roundNumber: state.roundNumber,
          spreadWidth: state.spreadWidth,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiErrorResponse;
        dispatch({
          type: "MARKET_COMMIT_FAILED",
          error: body.error ?? "Market could not be committed.",
        });
        return false;
      }

      return true;
    } finally {
      commitInFlight.current = false;
      setIsCommittingMarket(false);
    }
  }

  const status = (
    <div className="status-strip" aria-live="polite">
      <span className={`phase-chip phase-chip--${state.phase}`}>
        {phaseLabel(state.phase)}
      </span>
      <span>{state.roundNumber > 0 ? `Round ${state.roundNumber}` : "Ready"}</span>
    </div>
  );

  const scoreboard =
    state.phase === "setup" ? null : (
      <Scoreboard
        players={state.players}
        roles={state.roles}
        roundNumber={state.roundNumber}
        scores={state.scores}
        totalRounds={state.totalRounds}
      />
    );

  const actionLog =
    state.phase === "setup" ? null : <ActionLog entries={state.log} />;

  return (
    <GameShell actionLog={actionLog} scoreboard={scoreboard} status={status}>
      {state.phase === "setup" ? (
        <SetupForm
          defaultValues={{
            playerAName: state.players.A.name,
            playerBName: state.players.B.name,
            mode: state.mode,
            totalRounds: state.totalRounds,
            customAmazonQuery: state.customAmazonQuery,
          }}
          error={state.lastError}
          onStart={handleStart}
        />
      ) : null}

      {state.phase === "generatingItem" ? (
        (state.mode === "Amazon" && state.customAmazonQuery === true) ? (
          <CustomAmazonQueryForm
            disabled={isGeneratingCustomItem}
            generatorName={state.players[state.roles.trader].name}
            onSubmit={handleCustomAmazonQuerySubmit}
          />
        ) : (
          <section className="phase-panel" data-testid="generation-panel">
            <p className="eyebrow">Generating item</p>
            <h2>Preparing a quantitative market</h2>
            <p>{state.players[state.roles.marketMaker].name} will propose the first spread width.</p>
            <div className="loading-line" aria-label="Loading" />
          </section>
        )
      ) : null}

      {state.phase === "proposingWidth" ? (
        <div className="play-stack">
          <ItemPanel item={toPublicItem(state.item)} />
          <section className="phase-panel">
            <p className="eyebrow">Opening width</p>
            <h2>{state.players[state.roles.marketMaker].name}</h2>
            <SpreadWidthForm
              onSubmit={(width) => dispatch({ type: "SUBMIT_INITIAL_WIDTH", width })}
              submitLabel="Propose width"
            />
            {state.lastError ? (
              <p className="state-error" role="alert">
                {state.lastError}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {state.phase === "negotiatingWidth" ? (
        <div className="play-stack">
          <ItemPanel item={toPublicItem(state.item)} />
          <WidthNegotiationPanel
            onTighten={(width) => dispatch({ type: "TIGHTEN_WIDTH", width })}
            onTrade={() => dispatch({ type: "TRADE_ON_WIDTH" })}
            players={state.players}
            roles={state.roles}
            spreadWidth={state.spreadWidth}
          />
          {state.lastError ? (
            <p className="state-error" role="alert">
              {state.lastError}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.phase === "configuringMarket" ? (
        <div className="play-stack">
          <ItemPanel item={toPublicItem(state.item)} />
          <section className="phase-panel">
            <p className="eyebrow">Set fixed-width market</p>
            <h2>{state.players[state.roles.marketMaker].name}</h2>
            <p>
              {state.players[state.roles.trader].name} chose to trade on width{" "}
              {state.spreadWidth}. Set either bid or ask; the other side is
              generated automatically.
            </p>
            <MarketRangeForm
              disabled={isCommittingMarket}
              onSubmit={(quote) => {
                void commitMarket(quote).then((committed) => {
                  if (committed) {
                    dispatch({ type: "SUBMIT_MARKET_QUOTE", quote });
                  }
                });
              }}
              spreadWidth={state.spreadWidth}
            />
            {state.lastError ? (
              <p className="state-error" role="alert">
                {state.lastError}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {state.phase === "choosingSide" ? (
        <div className="play-stack">
          <ItemPanel item={toPublicItem(state.item)} />
          <TradeActionPanel
            onBuy={() => dispatch({ type: "EXECUTE_TRADE", side: "BUY" })}
            onSell={() => dispatch({ type: "EXECUTE_TRADE", side: "SELL" })}
            players={state.players}
            quote={state.quote}
            roles={state.roles}
          />
          {state.lastError ? (
            <p className="state-error" role="alert">
              {state.lastError}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.phase === "settling" ? (
        <div className="play-stack">
          <ItemPanel item={toPublicItem(state.item)} />
          <section className="phase-panel" data-testid="settling-panel">
            <p className="eyebrow">Settling trade</p>
            <h2>
              {state.players[state.roles.trader].name} chose{" "}
              {state.pendingSide === "BUY" ? "Buy" : "Sell"}
            </h2>
            <p>The server is revealing the true value and computing PnL.</p>
            <div className="loading-line" aria-label="Loading" />
          </section>
        </div>
      ) : null}

      {state.phase === "settlement" ? (
        <div className="play-stack">
          <ItemPanel item={state.item} revealTrueValue />
          <SettlementPanel
            isFinalRound={state.roundNumber >= state.totalRounds}
            onContinue={() => dispatch({ type: "NEXT_ROUND" })}
            players={state.players}
            settlement={state.settlement}
          />
        </div>
      ) : null}

      {state.phase === "gameOver" ? (
        <section className="phase-panel" data-testid="game-over-panel">
          <p className="eyebrow">End game</p>
          <h2>{state.winner === "Tie" ? "Tie game" : `${state.players[state.winner].name} wins`}</h2>
          <dl className="final-score">
            <div>
              <dt>{state.players.A.name}</dt>
              <dd>{formatSignedNumber(state.scores.A)}</dd>
            </div>
            <div>
              <dt>{state.players.B.name}</dt>
              <dd>{formatSignedNumber(state.scores.B)}</dd>
            </div>
          </dl>
          <button
            className="primary-button"
            onClick={() => dispatch({ type: "RESET" })}
            type="button"
          >
            Reset game
          </button>
        </section>
      ) : null}

      {state.phase === "error" ? (
        <section className="phase-panel" data-testid="error-panel">
          <p className="eyebrow">Generation error</p>
          <h2>Item generation stopped</h2>
          <p>{state.error}</p>
          <button
            className="primary-button"
            onClick={() => dispatch({ type: "RESET" })}
            type="button"
          >
            Reset game
          </button>
        </section>
      ) : null}
    </GameShell>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "generatingItem":
      return "Generating";
    case "proposingWidth":
      return "Proposing width";
    case "negotiatingWidth":
      return "Negotiating width";
    case "configuringMarket":
      return "Setting market";
    case "choosingSide":
      return "Choosing side";
    case "gameOver":
      return "Game over";
    default:
      return phase.charAt(0).toUpperCase() + phase.slice(1);
  }
}
