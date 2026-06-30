import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { SettlementPanel } from "./SettlementPanel";
import type { Player, PlayerId, RoundSettlement } from "../lib/game";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const players: Record<PlayerId, Player> = {
  A: { id: "A", name: "Alice" },
  B: { id: "B", name: "Bob" },
};

function makeSettlement(traderPnL: number, marketMakerPnL: number): RoundSettlement {
  return {
    roundNumber: 1,
    itemTitle: "Vintage Watch",
    side: "BUY",
    transactionPrice: 100,
    trueValue: 150,
    trader: "A",
    marketMaker: "B",
    traderPnL,
    marketMakerPnL,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettlementPanel", () => {
  it("T29a: positive traderPnL → data-outcome='win', role='status' present, profit text visible, 'Next round' button enabled", () => {
    render(
      <SettlementPanel
        players={players}
        settlement={makeSettlement(50, -50)}
        onContinue={vi.fn()}
      />
    );

    const result = screen.getByTestId("settlement-result");
    expect(result).toHaveAttribute("data-outcome", "win");
    expect(result).toHaveAttribute("role", "status");
    // "+50" profit text appears at least once (result area and PnL details row)
    expect(screen.getAllByText("+50").length).toBeGreaterThan(0);
    // "Profit" outcome word
    expect(screen.getByText("Profit")).toBeInTheDocument();

    const btn = screen.getByRole("button", { name: "Next round" });
    expect(btn).not.toBeDisabled();
  });

  it("T29b: negative traderPnL → data-outcome='loss'", () => {
    render(
      <SettlementPanel
        players={players}
        settlement={makeSettlement(-30, 30)}
        onContinue={vi.fn()}
      />
    );

    expect(screen.getByTestId("settlement-result")).toHaveAttribute(
      "data-outcome",
      "loss"
    );
  });

  it("T29c: traderPnL=0 → data-outcome='even'", () => {
    render(
      <SettlementPanel
        players={players}
        settlement={makeSettlement(0, 0)}
        onContinue={vi.fn()}
      />
    );

    expect(screen.getByTestId("settlement-result")).toHaveAttribute(
      "data-outcome",
      "even"
    );
  });

  it("T29d: isFinalRound=true → button label is 'End game'", () => {
    render(
      <SettlementPanel
        players={players}
        settlement={makeSettlement(50, -50)}
        onContinue={vi.fn()}
        isFinalRound
      />
    );

    expect(screen.getByRole("button", { name: "End game" })).toBeInTheDocument();
  });

  it("T29e: disabled=true → continue button is disabled, clicking does not call onContinue", () => {
    const onContinue = vi.fn();
    render(
      <SettlementPanel
        players={players}
        settlement={makeSettlement(50, -50)}
        onContinue={onContinue}
        disabled
      />
    );

    const btn = screen.getByRole("button", { name: "Next round" });
    expect(btn).toBeDisabled();

    fireEvent.click(btn);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("T29f: enabled state → clicking continue calls onContinue", () => {
    const onContinue = vi.fn();
    render(
      <SettlementPanel
        players={players}
        settlement={makeSettlement(50, -50)}
        onContinue={onContinue}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Next round" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
