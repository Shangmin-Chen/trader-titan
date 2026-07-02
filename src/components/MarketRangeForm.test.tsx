import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { MarketRangeForm } from "./MarketRangeForm";

describe("MarketRangeForm", () => {
  it("T24: typing Bid auto-fills Ask using spreadWidth", () => {
    render(<MarketRangeForm spreadWidth={100} onSubmit={vi.fn()} />);

    // quoteFromBid(200, 100) = { bid: 200, ask: 300 }
    fireEvent.change(screen.getByLabelText("Bid"), { target: { value: "200" } });

    expect(screen.getByLabelText("Ask")).toHaveValue(300);
  });

  it("T24b: typing Ask auto-fills Bid using spreadWidth", () => {
    render(<MarketRangeForm spreadWidth={100} onSubmit={vi.fn()} />);

    // quoteFromAsk(3700, 100) = { bid: 3600, ask: 3700 }
    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "3700" } });

    expect(screen.getByLabelText("Bid")).toHaveValue(3600);
  });

  it("T25: submitting with empty fields (non-finite quote) → error alert; onSubmit not called", () => {
    // NOTE: The component's setFromBid / setFromAsk handlers always keep the
    // spread consistent — typing in one field auto-fills the other to maintain
    // the exact spreadWidth. A truly mismatched spread is therefore unreachable
    // through UI interaction. The reachable validation-error path is submitting
    // while both fields are empty (NaN), which triggers the "must be finite
    // numbers" branch of validateQuoteForWidth.
    const onSubmit = vi.fn();
    render(<MarketRangeForm spreadWidth={100} onSubmit={onSubmit} />);

    // Fill bid then clear it — setFromBid("") also clears ask, so both are empty.
    fireEvent.change(screen.getByLabelText("Bid"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Bid"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Commit market" }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("T30: valid bid+ask submission — onSubmit called with correct Quote when spread is consistent", () => {
    const onSubmit = vi.fn();
    render(<MarketRangeForm spreadWidth={100} onSubmit={onSubmit} />);

    // Type 200 into Bid; setFromBid auto-fills Ask to 300 (200 + 100)
    fireEvent.change(screen.getByLabelText("Bid"), { target: { value: "200" } });

    fireEvent.click(screen.getByRole("button", { name: "Commit market" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({ bid: 200, ask: 300 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("submits large fractional bid plus width quotes without a spread mismatch", () => {
    const onSubmit = vi.fn();
    render(<MarketRangeForm spreadWidth={0.1} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Bid"), {
      target: { value: "100000000.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit market" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({
      bid: 100_000_000.5,
      ask: 100_000_000.6,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
