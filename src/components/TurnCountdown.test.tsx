import { render, screen, act } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TurnCountdown } from "./TurnCountdown";

describe("TurnCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the whole seconds remaining until the absolute deadline", () => {
    vi.setSystemTime(new Date(1_000_000));
    render(<TurnCountdown turnDeadlineMs={1_000_000 + 12_500} />);

    expect(screen.getByTestId("turn-countdown")).toHaveTextContent("13s");
  });

  it("counts down as time passes, tracking the wall clock rather than a server-sent remaining value", () => {
    vi.setSystemTime(new Date(1_000_000));
    render(<TurnCountdown turnDeadlineMs={1_000_000 + 5_000} />);

    expect(screen.getByTestId("turn-countdown")).toHaveTextContent("5s");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByTestId("turn-countdown")).toHaveTextContent("2s");
  });

  it("clamps at 0s instead of going negative once the deadline has passed", () => {
    vi.setSystemTime(new Date(1_000_000));
    render(<TurnCountdown turnDeadlineMs={999_000} />);

    expect(screen.getByTestId("turn-countdown")).toHaveTextContent("0s");
  });

  it("marks data-urgent once inside the final ten seconds", () => {
    vi.setSystemTime(new Date(1_000_000));
    const { rerender } = render(<TurnCountdown turnDeadlineMs={1_000_000 + 15_000} />);

    expect(screen.getByTestId("turn-countdown")).toHaveAttribute("data-urgent", "false");

    rerender(<TurnCountdown turnDeadlineMs={1_000_000 + 8_000} />);

    expect(screen.getByTestId("turn-countdown")).toHaveAttribute("data-urgent", "true");
  });
});
