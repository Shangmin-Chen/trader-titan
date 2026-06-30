import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CopyButton } from "./CopyButton";

// ---------------------------------------------------------------------------
// Clipboard mock helpers
// ---------------------------------------------------------------------------

function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

function clearClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

// In jsdom, navigator.share is not defined, so the share branch is never
// entered; we only need to guard against it in tests that want clipboard.

describe("CopyButton", () => {
  it("(a) renders with an accessible name derived from the label prop", () => {
    render(<CopyButton value="https://example.com" label="Copy invite link" />);
    expect(
      screen.getByRole("button", { name: "Copy invite link" })
    ).toBeInTheDocument();
  });

  it("(a) accessible name falls back to default 'Copy link' label", () => {
    render(<CopyButton value="https://example.com" />);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("(a) ariaLabel prop overrides computed accessible name", () => {
    render(
      <CopyButton
        value="https://example.com"
        label="Copy link"
        ariaLabel="Share room invite"
      />
    );
    expect(
      screen.getByRole("button", { name: "Share room invite" })
    ).toBeInTheDocument();
  });

  describe("clipboard interaction", () => {
    const writeText = vi.fn();

    beforeEach(() => {
      writeText.mockReset();
      writeText.mockResolvedValue(undefined);
      stubClipboard(writeText);
    });

    afterEach(() => {
      clearClipboard();
    });

    it("(b) clicking the button calls navigator.clipboard.writeText with the value", async () => {
      render(<CopyButton value="https://example.com" />);
      const btn = screen.getByRole("button");

      fireEvent.click(btn);

      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("https://example.com")
      );
    });

    it("(c) shows the copiedLabel after a successful copy", async () => {
      render(
        <CopyButton value="https://example.com" label="Copy link" copiedLabel="Copied!" />
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

      await waitFor(() =>
        expect(screen.getByText("Copied!")).toBeInTheDocument()
      );
    });

    it("(d) resets to the idle label after resetDelayMs elapses", async () => {
      vi.useFakeTimers();
      render(
        <CopyButton
          value="https://example.com"
          label="Copy link"
          resetDelayMs={500}
        />
      );

      fireEvent.click(screen.getByRole("button"));

      // Let the clipboard promise resolve before advancing timers.
      await act(async () => {
        await Promise.resolve();
      });

      // Should show "Copied" now.
      expect(screen.getByText("Copied")).toBeInTheDocument();

      // Advance past the reset delay.
      await act(async () => {
        vi.advanceTimersByTime(501);
      });

      expect(screen.getByText("Copy link")).toBeInTheDocument();

      vi.useRealTimers();
    });
  });

  describe("graceful degradation", () => {
    beforeEach(() => {
      clearClipboard();
    });

    afterEach(() => {
      clearClipboard();
    });

    it("(e) does not throw when navigator.clipboard is unavailable", async () => {
      render(<CopyButton value="https://example.com" />);
      const btn = screen.getByRole("button");

      // Click should not throw even without clipboard or share.
      await act(async () => {
        fireEvent.click(btn);
        await Promise.resolve();
      });

      // Component is still mounted and functional.
      expect(btn).toBeInTheDocument();
    });
  });
});
