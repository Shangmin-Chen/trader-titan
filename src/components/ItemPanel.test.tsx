import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SettledGeneratedItem } from "../lib/game";
import { ItemPanel } from "./ItemPanel";

const settledItem: SettledGeneratedItem = {
  round_id: "round-item-panel-1",
  item_title: "Vintage Calculator",
  category: "Static Landmarks & History",
  context_clue: "A collectible desktop calculator listing.",
  true_value: 349.99,
};

describe("ItemPanel", () => {
  it("renders the true value when revealTrueValue is enabled", () => {
    render(<ItemPanel item={settledItem} revealTrueValue />);

    expect(screen.getByText("True value")).toBeInTheDocument();
    expect(screen.getByText("349.99")).toBeInTheDocument();
  });

  it("does not render settled-only fields until revealTrueValue is enabled", () => {
    render(<ItemPanel item={settledItem} />);

    expect(screen.queryByText("True value")).not.toBeInTheDocument();
  });
});
