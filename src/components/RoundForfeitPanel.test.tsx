import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { RoundForfeitPanel } from "./RoundForfeitPanel";
import type { Player, PlayerId, RoundForfeit } from "../lib/game";

const players: Record<PlayerId, Player> = {
  A: { id: "A", name: "Alice" },
  B: { id: "B", name: "Bob" },
};

function makeForfeit(overrides: Partial<RoundForfeit> = {}): RoundForfeit {
  return {
    roundNumber: 2,
    itemTitle: "Vintage Watch",
    phase: "negotiatingWidth",
    forfeitedBy: "B",
    awardedTo: "A",
    penalty: 200,
    ...overrides,
  };
}

describe("RoundForfeitPanel", () => {
  it("names the player who ran out of time and the penalty amount", () => {
    render(
      <RoundForfeitPanel
        forfeit={makeForfeit()}
        onContinue={vi.fn()}
        players={players}
      />,
    );

    expect(screen.getByText("Bob ran out of time")).toBeInTheDocument();
    expect(screen.getByText("-200")).toBeInTheDocument();
    expect(screen.getByText("200 awarded to Alice")).toBeInTheDocument();
  });

  it("shows a loss outcome on the result card", () => {
    render(
      <RoundForfeitPanel
        forfeit={makeForfeit()}
        onContinue={vi.fn()}
        players={players}
      />,
    );

    expect(screen.getByTestId("round-forfeit-result")).toHaveAttribute(
      "data-outcome",
      "loss",
    );
  });

  it("isFinalRound=true renders 'End game'", () => {
    render(
      <RoundForfeitPanel
        forfeit={makeForfeit()}
        isFinalRound
        onContinue={vi.fn()}
        players={players}
      />,
    );

    expect(screen.getByRole("button", { name: "End game" })).toBeInTheDocument();
  });

  it("disabled=true prevents onContinue from firing", () => {
    const onContinue = vi.fn();
    render(
      <RoundForfeitPanel
        disabled
        forfeit={makeForfeit()}
        onContinue={onContinue}
        players={players}
      />,
    );

    const btn = screen.getByRole("button", { name: "Next round" });
    expect(btn).toBeDisabled();

    fireEvent.click(btn);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("enabled state calls onContinue on click", () => {
    const onContinue = vi.fn();
    render(
      <RoundForfeitPanel
        forfeit={makeForfeit()}
        onContinue={onContinue}
        players={players}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next round" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
