import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { TradeActionPanel } from "./TradeActionPanel";
import type { Player, PlayerId, Quote, Roles } from "../lib/game";

// Minimal fixture data ---------------------------------------------------

const players: Record<PlayerId, Player> = {
  A: { id: "A", name: "Alice" },
  B: { id: "B", name: "Bob" },
};

// Market maker = A, trader = B
const roles: Roles = {
  marketMaker: "A",
  trader: "B",
};

// bid=100, ask=200 → formatNumber renders "100" / "200" (no comma needed)
const quote: Quote = { bid: 100, ask: 200 };

// ------------------------------------------------------------------------

describe("TradeActionPanel", () => {
  it("T26: disabled=true → Buy and Sell buttons carry disabled attribute; role=status contains 'Waiting for'", () => {
    render(
      <TradeActionPanel
        disabled
        onBuy={vi.fn()}
        onSell={vi.fn()}
        players={players}
        quote={quote}
        roles={roles}
      />
    );

    expect(screen.getByRole("button", { name: "Buy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sell" })).toBeDisabled();

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Waiting for/);
  });

  it("T27: Buy button aria-describedby resolves to ask-price span; Sell resolves to bid-price span", () => {
    render(
      <TradeActionPanel
        onBuy={vi.fn()}
        onSell={vi.fn()}
        players={players}
        quote={quote}
        roles={roles}
      />
    );

    // Buy button → described by the hidden span that mentions the ask price
    const buyBtn = screen.getByRole("button", { name: "Buy" });
    const buyDescId = buyBtn.getAttribute("aria-describedby");
    expect(buyDescId).toBeTruthy();
    const buyDesc = document.getElementById(buyDescId!);
    expect(buyDesc).not.toBeNull();
    expect(buyDesc).toHaveTextContent(/200/); // ask price

    // Sell button → described by the hidden span that mentions the bid price
    const sellBtn = screen.getByRole("button", { name: "Sell" });
    const sellDescId = sellBtn.getAttribute("aria-describedby");
    expect(sellDescId).toBeTruthy();
    const sellDesc = document.getElementById(sellDescId!);
    expect(sellDesc).not.toBeNull();
    expect(sellDesc).toHaveTextContent(/100/); // bid price
  });
});
