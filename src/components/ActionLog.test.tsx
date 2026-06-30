import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, it, expect } from "vitest";
import { ActionLog } from "./ActionLog";
import type { RoundLogEntry } from "../lib/game";

function makeEntry(id: number, message: string): RoundLogEntry {
  return { id, roundNumber: 1, phase: "choosingSide", message };
}

describe("ActionLog", () => {
  it("T28a: renders empty state — emptyMessage appears, no list items", () => {
    render(<ActionLog entries={[]} emptyMessage="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("T28b: toggle button has aria-expanded=true initially; clicking flips it to false", () => {
    render(<ActionLog entries={[]} />);
    const toggle = screen.getByRole("button", { name: /Action log/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("T28c: aria-controls on toggle matches id on body div", () => {
    render(<ActionLog entries={[]} />);
    const toggle = screen.getByRole("button", { name: /Action log/ });
    const controlsId = toggle.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    const bodyDiv = document.getElementById(controlsId!);
    expect(bodyDiv).not.toBeNull();
  });

  it("T28d: with entries, button label contains entry count; sr-only live region text matches last entry's description", () => {
    const entries: RoundLogEntry[] = [
      makeEntry(1, "First action"),
      makeEntry(2, "Second action"),
    ];
    render(<ActionLog entries={entries} />);

    // Button label should include entry count
    expect(
      screen.getByRole("button", { name: /Action log \(2\)/ })
    ).toBeInTheDocument();

    // sr-only polite live region reflects the last entry's description
    // describeEntry(entry) = `Round ${entry.roundNumber}, ${entry.phase}: ${entry.message}`
    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toHaveTextContent(
      "Round 1, choosingSide: Second action"
    );
  });
});
