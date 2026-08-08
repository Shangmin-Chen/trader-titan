import { expect, test } from "@playwright/test";
import {
  createAndJoinRoom,
  fastForwardTurnClock,
  ROOM_PHASE_TIMEOUT_MS,
  roomIdFromInviteUrl,
} from "./helpers";

// F-05 shot clock: prior to this file, nothing in e2e/ ever let a clocked
// phase's turnDeadlineMs actually elapse, and nothing ever asserted that
// TurnCountdown or RoundForfeitPanel render at all. That gap is exactly why
// a completely absent `.turn-countdown` CSS rule (and an unstyled shot
// clock) previously shipped through review with every other test still
// green - nothing was rendering the countdown in a real browser and
// checking what came back. These tests drive a real clock down to a real
// expiry via the test-only fast-forward endpoint (see fastForwardTurnClock
// in ./helpers and E2E_FAST_FORWARD_TURN_OFFSET_MS in src/worker/index.ts)
// rather than mocking any part of the countdown or expiry logic.
//
// Real turn durations are 30-60s (see *_TURN_DURATION_MS in
// src/lib/game/types.ts); sleeping a test out for that long would be both
// slow and flaky, so these tests fast-forward the deadline to a few seconds
// away instead of waiting from the very start. The countdown, the alarm,
// the reducer transition, persistence, and the WebSocket broadcast are all
// the genuine production code paths - only the wait is shortened.
const CLOCK_EXPIRY_TIMEOUT_MS = 10_000;

test.describe("F-05 turn shot clock", () => {
  test("a proposingWidth clock reaches its urgent state and, left to expire, forfeits the round", async ({
    baseURL,
    browser,
  }) => {
    test.setTimeout(60_000);

    const { host, guest, inviteUrl } = await createAndJoinRoom(browser, baseURL);
    const roomId = roomIdFromInviteUrl(inviteUrl);

    await host.getByRole("button", { name: "Start game" }).click();

    await expect(host.getByTestId("custom-amazon-query-form")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await host
      .getByLabel("Search Term / Product Name")
      .fill("mechanical keyboard");
    await host.getByRole("button", { name: "Submit & Scrape Price" }).click();

    // Item generated -> proposingWidth. It's the market maker's (guest's)
    // turn, but the countdown itself renders identically for both players
    // off the same shared game.turnDeadlineMs.
    await expect(host.getByTestId("item-panel")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });

    const countdown = host.getByTestId("turn-countdown");

    await expect(countdown).toBeVisible();
    // A fresh 60s proposingWidth deadline is nowhere near the 10s urgent
    // threshold yet.
    await expect(countdown).toHaveAttribute("data-urgent", "false");

    await fastForwardTurnClock(host, roomId);

    // The fast-forwarded deadline is inside the 10s urgent threshold as
    // soon as the broadcast lands - no need to wait out any more of the
    // clock to observe it.
    await expect(countdown).toHaveAttribute("data-urgent", "true", {
      timeout: 3_000,
    });

    // Left alone from here, the real Durable Object alarm fires against
    // the fast-forwarded deadline and TURN_EXPIRED forfeits the round -
    // nobody has seen a quote yet in proposingWidth, so this is the flat
    // width-fallback penalty, not F-06's forced settlement.
    await expect(host.getByTestId("round-forfeit-panel")).toBeVisible({
      timeout: CLOCK_EXPIRY_TIMEOUT_MS,
    });
    await expect(guest.getByTestId("round-forfeit-panel")).toBeVisible({
      timeout: CLOCK_EXPIRY_TIMEOUT_MS,
    });
    await expect(host.getByTestId("round-forfeit-panel")).toContainText(
      "Grace ran out of time",
    );
    // Item 3 (PR #18): RoundForfeitPanel must render the phase through the
    // same shared label helper page.tsx's status chip uses, not the bare
    // GamePhase enum string.
    await expect(host.getByTestId("round-forfeit-panel")).toContainText(
      "Proposing width",
    );
    await expect(host.getByTestId("round-forfeit-panel")).not.toContainText(
      "proposingWidth",
    );
  });

  test("a choosingSide clock left to expire settles the round against the trader's worse side instead of forfeiting it (F-06)", async ({
    baseURL,
    browser,
  }) => {
    test.setTimeout(60_000);

    const { host, guest, inviteUrl } = await createAndJoinRoom(browser, baseURL);
    const roomId = roomIdFromInviteUrl(inviteUrl);

    await host.getByRole("button", { name: "Start game" }).click();

    await expect(host.getByTestId("custom-amazon-query-form")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await host
      .getByLabel("Search Term / Product Name")
      .fill("mechanical keyboard");
    await host.getByRole("button", { name: "Submit & Scrape Price" }).click();

    await expect(host.getByTestId("item-panel")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });

    // proposingWidth: guest is the market maker.
    await guest.getByRole("spinbutton", { name: "Spread width" }).fill("100");
    await guest.getByRole("button", { name: "Propose width" }).click();

    // negotiatingWidth: host is the trader, trades on the proposed width
    // rather than tightening it.
    await expect(host.getByTestId("width-negotiation-panel")).toContainText(
      /Current width:?\s*100/,
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );
    await host.getByRole("button", { name: "Trade on width" }).click();

    // configuringMarket: guest (market maker) sets the fixed-width quote.
    await expect(guest.getByTestId("market-range-form")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await guest.getByRole("spinbutton", { name: "Ask" }).fill("3700");
    await expect(guest.getByRole("spinbutton", { name: "Bid" })).toHaveValue(
      "3600",
    );
    await guest.getByRole("button", { name: "Commit market" }).click();

    // choosingSide: host (trader) has now seen the quote (3,600 / 3,700)
    // but deliberately never clicks Buy or Sell.
    await expect(host.getByTestId("trade-action-panel")).toContainText(
      "Quote: 3,600 / 3,700",
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );

    const countdown = host.getByTestId("turn-countdown");

    await expect(countdown).toBeVisible();
    // A fresh 30s choosingSide deadline is nowhere near the 10s urgent
    // threshold yet.
    await expect(countdown).toHaveAttribute("data-urgent", "false");

    await fastForwardTurnClock(host, roomId);

    await expect(countdown).toHaveAttribute("data-urgent", "true", {
      timeout: 3_000,
    });

    // F-06: choosingSide's clock expiring must settle - never forfeit -
    // since the trader has already seen the quote by this phase. The
    // outcome must reach both players and be marked forced-by-timeout, not
    // read as a trade the trader actually chose.
    await expect(host.getByTestId("settlement-panel")).toBeVisible({
      timeout: CLOCK_EXPIRY_TIMEOUT_MS,
    });
    await expect(guest.getByTestId("settlement-panel")).toBeVisible({
      timeout: CLOCK_EXPIRY_TIMEOUT_MS,
    });
    await expect(host.getByTestId("round-forfeit-panel")).toHaveCount(0);
    await expect(host.getByTestId("settlement-forced-note")).toBeVisible();
    await expect(host.getByTestId("settlement-forced-note")).toContainText(
      "Ada",
    );
  });
});
