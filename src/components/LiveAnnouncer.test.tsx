import React from "react";
import { render, screen, act, renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { LiveAnnouncerProvider, useAnnouncer } from "./LiveAnnouncer";

// Helper: renders a provider and captures the announce function via ref.
function setup() {
  let capturedAnnounce: ReturnType<typeof useAnnouncer>["announce"] | null = null;

  function Capture() {
    const { announce } = useAnnouncer();
    capturedAnnounce = announce;
    return null;
  }

  render(
    <LiveAnnouncerProvider>
      <Capture />
    </LiveAnnouncerProvider>,
  );

  return {
    announce: (...args: Parameters<NonNullable<typeof capturedAnnounce>>) =>
      act(() => {
        capturedAnnounce!(...args);
      }),
    polite: () => screen.getByTestId("announcer-polite"),
    assertive: () => screen.getByTestId("announcer-assertive"),
  };
}

describe("LiveAnnouncer", () => {
  // T2 ─────────────────────────────────────────────────────────────────────
  it("T2: announce('') is a no-op — announcer-polite stays empty", () => {
    const { announce, polite, assertive } = setup();

    announce("");

    expect(polite().textContent).toBe("");
    expect(assertive().textContent).toBe("");
  });

  // T3 ─────────────────────────────────────────────────────────────────────
  it("T3: polite route puts text in polite region; assertive route puts text in assertive region and leaves polite unchanged", () => {
    const { announce, polite, assertive } = setup();

    announce("hello");

    expect(polite().textContent).toBe("hello");
    expect(assertive().textContent).toBe("");

    announce("err", "assertive");

    expect(assertive().textContent).not.toBe("");
    // polite region must be unchanged from its value after the first announce
    expect(polite().textContent).toBe("hello");
  });

  // T4 ─────────────────────────────────────────────────────────────────────
  it("T4: ZWS toggle — announcing the same message twice gives a non-identical second textContent, both non-empty", () => {
    const { announce, polite } = setup();

    announce("Same");
    expect(polite().textContent).toBe("Same");

    announce("Same");
    const secondContent = polite().textContent ?? "";
    expect(secondContent).not.toBe("Same");
    expect(secondContent.length).toBeGreaterThan(0);
  });

  // T5 ─────────────────────────────────────────────────────────────────────
  it("T5: useAnnouncer() outside a provider throws with a message containing 'LiveAnnouncerProvider'", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useAnnouncer())).toThrow(
        /LiveAnnouncerProvider/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
