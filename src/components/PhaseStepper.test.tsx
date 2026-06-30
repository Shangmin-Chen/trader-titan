import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PhaseStepper } from "./PhaseStepper";

const STEPS = [
  { id: "w", label: "Width" },
  { id: "t", label: "Trade" },
  { id: "s", label: "Settle" },
];

describe("PhaseStepper", () => {
  // T19 ─────────────────────────────────────────────────────────────────────
  it("T19: correct data-state and aria-current when currentStepId='t'", () => {
    render(<PhaseStepper steps={STEPS} currentStepId="t" />);

    const nav = screen.getByTestId("phase-stepper");
    expect(nav).toBeInTheDocument();

    const items = within(nav).getAllByRole("listitem");
    expect(items).toHaveLength(3);

    const [widthItem, tradeItem, settleItem] = items;

    // Width → complete, no aria-current
    expect(widthItem).toHaveAttribute("data-state", "complete");
    expect(widthItem).not.toHaveAttribute("aria-current");

    // Trade → active, aria-current="step"
    expect(tradeItem).toHaveAttribute("data-state", "active");
    expect(tradeItem).toHaveAttribute("aria-current", "step");

    // Settle → upcoming, no aria-current
    expect(settleItem).toHaveAttribute("data-state", "upcoming");
    expect(settleItem).not.toHaveAttribute("aria-current");
  });

  // T20 ─────────────────────────────────────────────────────────────────────
  it("T20: currentStepId='nonexistent' → all items data-state='upcoming', none has aria-current", () => {
    render(<PhaseStepper steps={STEPS} currentStepId="nonexistent" />);

    const nav = screen.getByTestId("phase-stepper");
    const items = within(nav).getAllByRole("listitem");

    for (const item of items) {
      expect(item).toHaveAttribute("data-state", "upcoming");
      expect(item).not.toHaveAttribute("aria-current");
    }
  });

  // T35a ────────────────────────────────────────────────────────────────────
  it("T35a: default ariaLabel — nav has accessible name 'Round progress'", () => {
    render(<PhaseStepper steps={STEPS} currentStepId="w" />);
    expect(
      screen.getByRole("navigation", { name: "Round progress" })
    ).toBeInTheDocument();
  });

  // T35b ────────────────────────────────────────────────────────────────────
  it("T35b: custom ariaLabel prop — nav has the custom accessible name", () => {
    render(
      <PhaseStepper steps={STEPS} currentStepId="w" ariaLabel="Game phases" />
    );
    expect(
      screen.getByRole("navigation", { name: "Game phases" })
    ).toBeInTheDocument();
  });
});
