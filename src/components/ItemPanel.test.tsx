import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SettledGeneratedItem } from "../lib/game";
import { ItemPanel } from "./ItemPanel";

const amazonSettledItem: SettledGeneratedItem = {
  round_id: "round-item-panel-1",
  item_title: "Vintage Calculator",
  category: "Amazon",
  context_clue: "A collectible desktop calculator listing.",
  true_value: 349.99,
  scraped_items: [
    { title: "Vintage Calculator - Source Listing", price: 349.99 },
    { title: "Vintage Calculator - Comparable Listing", price: 329.5 },
  ],
  amazon_url: "https://www.amazon.com/s?k=vintage%20calculator",
};

describe("ItemPanel", () => {
  it("renders settled Amazon metadata when the true value is revealed", () => {
    render(<ItemPanel item={amazonSettledItem} revealTrueValue />);

    expect(screen.getByText("True value")).toBeInTheDocument();
    expect(screen.getByText("349.99")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /view amazon search/i });
    expect(link).toHaveAttribute(
      "href",
      "https://www.amazon.com/s?k=vintage%20calculator",
    );

    const listings = screen.getByRole("list", {
      name: /scraped amazon listings/i,
    });
    expect(
      within(listings).getByText("Vintage Calculator - Source Listing"),
    ).toBeInTheDocument();
    expect(within(listings).getByText("$349.99")).toBeInTheDocument();
    expect(
      within(listings).getByText("Vintage Calculator - Comparable Listing"),
    ).toBeInTheDocument();
    expect(within(listings).getByText("$329.5")).toBeInTheDocument();
  });

  it("does not render settled-only fields until revealTrueValue is enabled", () => {
    render(<ItemPanel item={amazonSettledItem} />);

    expect(screen.queryByText("True value")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /view amazon search/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: /scraped amazon listings/i }),
    ).not.toBeInTheDocument();
  });
});
