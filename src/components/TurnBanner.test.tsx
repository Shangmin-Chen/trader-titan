import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TurnBanner } from "./TurnBanner";

describe("TurnBanner", () => {
  // T17a ────────────────────────────────────────────────────────────────────
  it("T17a: isYourTurn=true intent='buy' → turn-banner--buy class, data-your-turn='true', text 'Your move'", () => {
    render(<TurnBanner isYourTurn={true} intent="buy" />);
    const banner = screen.getByTestId("turn-banner");
    expect(banner.className).toContain("turn-banner--buy");
    expect(banner).toHaveAttribute("data-your-turn", "true");
    expect(screen.getByText("Your move")).toBeInTheDocument();
  });

  // T17b ────────────────────────────────────────────────────────────────────
  it("T17b: isYourTurn=true intent='sell' → turn-banner--sell class", () => {
    render(<TurnBanner isYourTurn={true} intent="sell" />);
    const banner = screen.getByTestId("turn-banner");
    expect(banner.className).toContain("turn-banner--sell");
  });

  // T17c ────────────────────────────────────────────────────────────────────
  it("T17c: isYourTurn=true intent='neutral' → neither --buy nor --sell in className", () => {
    render(<TurnBanner isYourTurn={true} intent="neutral" />);
    const banner = screen.getByTestId("turn-banner");
    expect(banner.className).not.toContain("--buy");
    expect(banner.className).not.toContain("--sell");
  });

  // T18a ────────────────────────────────────────────────────────────────────
  // Note: aria-live and aria-atomic are implied by role="status" per WAI-ARIA
  // spec; explicit attributes were removed (N-new-1 fix). We verify role only.
  it("T18a: isYourTurn=false waitingForName='Ada' → 'Waiting for Ada', role=status, data-your-turn='false'", () => {
    render(<TurnBanner isYourTurn={false} waitingForName="Ada" />);
    const banner = screen.getByTestId("turn-banner");
    expect(screen.getByText("Waiting for Ada")).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("data-your-turn", "false");
  });

  // T18b ────────────────────────────────────────────────────────────────────
  it("T18b: isYourTurn=false with no waitingForName → text 'Waiting'", () => {
    render(<TurnBanner isYourTurn={false} />);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
  });

  // N3 ──────────────────────────────────────────────────────────────────────
  it("N3: data-testid='turn-banner' is present on the root element", () => {
    render(<TurnBanner isYourTurn={true} />);
    expect(screen.getByTestId("turn-banner")).toBeInTheDocument();
  });
});
