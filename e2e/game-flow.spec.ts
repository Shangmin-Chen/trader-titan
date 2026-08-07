import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const ROOM_PHASE_TIMEOUT_MS = 15_000;
// The reconnect supervisor's heartbeat watchdog needs up to ~40s to notice a
// socket that went silent without a clean close (20s ping interval, 10s pong
// deadline, 2 missed pongs) before it force-closes the socket and the
// backoff loop reopens it. Give assertions that depend on that full detour
// through the watchdog (rather than an immediate transport-level close)
// enough headroom.
const HEARTBEAT_RECOVERY_TIMEOUT_MS = 75_000;

test.describe("Cloudflare room invite flow", () => {
  test("creates an invite room, plays one round, and frees the guest slot", async ({
    baseURL,
    browser,
  }) => {
    test.setTimeout(90_000);

    const { host, guest, inviteUrl } = await createAndJoinRoom(browser, baseURL);

    await expect(host.getByRole("button", { name: "Start game" })).toBeEnabled();

    await guest.reload();
    await expect(guest.getByTestId("room-controls")).toBeVisible();

    await host.getByRole("button", { name: "Start game" }).click();
    await playDefaultQueryRoundToSettlement(host, guest);

    await host.getByRole("button", { name: "End game" }).click();
    await expect(host.getByTestId("game-over-panel")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });

    await host
      .getByTestId("room-controls")
      .getByRole("button", { name: "Reset lobby" })
      .click();
    await expect(host.getByTestId("lobby-panel")).toBeVisible();
    await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
    await guest.reload();
    await expect(guest.getByTestId("join-room-form")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });

    await guest.getByTestId("join-room-form").getByLabel("Your name").fill("Katherine");
    await guest.getByRole("button", { name: "Join as player B" }).click();
    await expect(guest.getByTestId("room-controls")).toBeVisible();
    await expect(host.getByRole("button", { name: "Start game" })).toBeEnabled({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });

    await host
      .getByTestId("room-controls")
      .getByRole("button", { name: "Kick guest" })
      .click();
    await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
    await guest.reload();
    await expect(guest.getByTestId("join-room-form")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });

    expect(inviteUrl).toContain("?room=room-");
    expect(inviteUrl).not.toContain("secret=");
  });

  test("blocks non-final settlement advance while player B is offline and recovers on reconnect", async ({
    baseURL,
    browser,
  }) => {
    test.setTimeout(120_000);

    const { host, guest, inviteUrl } = await createAndJoinRoom(browser, baseURL, {
      totalRounds: 2,
    });

    await expect(host.getByRole("button", { name: "Start game" })).toBeEnabled();
    await host.getByRole("button", { name: "Start game" }).click();
    await playDefaultQueryRoundToSettlement(host, guest);

    await guest.goto("about:blank");

    await expect(host.getByTestId("room-controls")).toContainText(
      "Player B: Disconnected",
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );
    await expect(host.getByRole("button", { name: "Next round" })).toBeDisabled();
    await expect(host.getByTestId("settlement-panel")).toContainText(
      "Player B is disconnected",
    );

    const roomSettings = host.getByRole("button", { name: /Room settings/ });
    if ((await roomSettings.getAttribute("aria-expanded")) === "false") {
      await roomSettings.click();
    }
    await expect(host.getByRole("button", { name: "Reset lobby" })).toBeEnabled();
    await expect(host.getByRole("button", { name: "Kick guest" })).toBeEnabled();

    await guest.goto(inviteUrl);
    await expect(guest.getByTestId("room-controls")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await expect(host.getByTestId("room-controls")).toContainText(
      "Player B: Connected",
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );

    await expect(host.getByRole("button", { name: "Next round" })).toBeEnabled();
    await host.getByRole("button", { name: "Next round" }).click();

    // Round 2 alternates roles: the guest is now the trader who enters the
    // query, after which the host makes the market.
    await expect(guest.getByTestId("custom-amazon-query-form")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await guest.getByLabel("Search Term / Product Name").fill("standing desk");
    await guest.getByRole("button", { name: "Submit & Scrape Price" }).click();

    await expect(host.getByRole("button", { name: "Propose width" })).toBeEnabled({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await expect(guest.getByRole("button", { name: "Propose width" })).toBeDisabled();
  });

  test("keeps lobby start blocked while player B is disconnected and enables it on reconnect", async ({
    baseURL,
    browser,
  }) => {
    test.setTimeout(90_000);

    const { host, guest, inviteUrl } = await createAndJoinRoom(browser, baseURL);

    await expect(host.getByRole("button", { name: "Start game" })).toBeEnabled();

    await guest.goto("about:blank");

    await expect(host.getByTestId("room-controls")).toContainText(
      "Player B: Disconnected",
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );
    await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();
    await expect(host.getByText("Player B is disconnected")).toBeVisible();

    await guest.goto(inviteUrl);
    await expect(guest.getByTestId("room-controls")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await expect(host.getByTestId("room-controls")).toContainText(
      "Player B: Connected",
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );
    await expect(host.getByRole("button", { name: "Start game" })).toBeEnabled();
  });

  // T-4: unlike the reconnect tests above (which use guest.goto to simulate
  // a drop, then guest.goto(inviteUrl) to "reconnect" — really a fresh page
  // load and a brand-new socket), this exercises the actual client-side
  // reconnect supervisor: the guest's page never navigates or reloads, so
  // any recovery must come from src/lib/room-socket-supervisor.ts reopening
  // the socket on its own after the drop.
  //
  // `browserContext.setOffline()` is deliberately NOT used here: it blocks
  // new HTTP requests via CDP network emulation, but it does not tear down
  // an already-established WebSocket, so the guest's socket stays alive and
  // functional straight through it — no drop is actually simulated. Instead
  // this uses `page.routeWebSocket()` to sit between the guest's real
  // WebSocket and the real server and, on command, silently stop relaying
  // frames in both directions without ever sending a close frame — a
  // genuine "network black hole" that only the heartbeat watchdog (not a
  // close/error event) can detect. That is specifically the scenario the
  // watchdog exists for: an established connection that goes silent
  // without a clean close (dead Wi-Fi radio, closed laptop lid, killed
  // mobile app in the background).
  test("guest socket reopens after a silent connection drop without a page reload, and both clients converge on the same phase (T-4)", async ({
    baseURL,
    browser,
  }) => {
    // Covers: room setup, one full round to settlement, the full
    // heartbeat-watchdog detection cycle, and round 2 setup after recovery.
    test.setTimeout(180_000);

    let severed = false;

    const { host, guest } = await createAndJoinRoom(browser, baseURL, {
      totalRounds: 2,
      async beforeGuestJoin(guestPage) {
        // Must be installed before the guest's first socket connects (i.e.
        // before the join-room click below), so it also governs the very
        // socket that carries round 1 — not just a later reconnect.
        await guestPage.routeWebSocket(/\/socket(?:\?.*)?$/, (route) => {
          const server = route.connectToServer();

          route.onMessage((message) => {
            if (!severed) {
              server.send(message);
            }
            // else: drop it on the floor. In particular this swallows the
            // client's own "tt-ping" frames, so the real server never
            // answers and the client-side watchdog is the only thing that
            // can ever notice.
          });

          server.onMessage((message) => {
            if (!severed) {
              route.send(message);
            }
            // else: drop the real server's replies too (including any
            // "tt-pong"), so nothing gets through in either direction.
          });

          // Overriding onClose disables the library's default close
          // forwarding, so it must be redone by hand. The one behavior
          // added on top: once the *page* side closes (which is always the
          // client-side watchdog's own `socket.close(4000, ...)` call,
          // since we are dropping everything else), stop severing so the
          // reconnect supervisor's next attempt — routed through this same
          // handler — passes through untouched and can actually succeed.
          route.onClose((code, reason) => {
            severed = false;
            void server.close({ code, reason });
          });
        });
      },
    });

    await expect(host.getByRole("button", { name: "Start game" })).toBeEnabled();
    await host.getByRole("button", { name: "Start game" }).click();
    await playDefaultQueryRoundToSettlement(host, guest);

    severed = true;

    // The server has no independent way to notice this — it never receives
    // a close frame until the client's own watchdog eventually sends one
    // (see the PR description's "Discovered, not fixed" section) — so this
    // assertion can only pass once two ping/pong cycles have gone
    // unanswered (~40-60s) and the watchdog force-closes the socket.
    await expect(host.getByTestId("room-controls")).toContainText(
      "Player B: Disconnected",
      { timeout: HEARTBEAT_RECOVERY_TIMEOUT_MS },
    );
    await expect(host.getByRole("button", { name: "Next round" })).toBeDisabled();
    await expect(host.getByTestId("settlement-panel")).toContainText(
      "Player B is disconnected",
    );

    // No guest.reload() / guest.goto() / setOffline(false) anywhere below:
    // recovery must come entirely from the reconnect supervisor's own
    // backoff loop reopening a (this time unmolested) socket.
    await expect(guest.getByTestId("room-controls")).toContainText(
      "This browser: Live",
      { timeout: HEARTBEAT_RECOVERY_TIMEOUT_MS },
    );
    await expect(host.getByTestId("room-controls")).toContainText(
      "Player B: Connected",
      { timeout: HEARTBEAT_RECOVERY_TIMEOUT_MS },
    );

    // Convergence, not just "a socket is open": the host can now advance
    // the round, and round 2 (which requires the guest to submit the
    // query, i.e. the guest's client has to be on the same phase the host
    // just advanced it to) proceeds exactly as it would with an
    // uninterrupted connection.
    await expect(host.getByRole("button", { name: "Next round" })).toBeEnabled();
    await host.getByRole("button", { name: "Next round" }).click();

    await expect(guest.getByTestId("custom-amazon-query-form")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await guest.getByLabel("Search Term / Product Name").fill("standing desk");
    await guest.getByRole("button", { name: "Submit & Scrape Price" }).click();

    await expect(host.getByRole("button", { name: "Propose width" })).toBeEnabled({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await expect(guest.getByRole("button", { name: "Propose width" })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Mobile viewport + a11y smoke tests
// These are network-independent page-load assertions; they require the dev
// server to be running (same as the suite above) but do not execute any game
// flow steps.
// ---------------------------------------------------------------------------
test.describe("Mobile viewport and a11y smoke", () => {
  test("main lobby panel is visible on a 375×812 mobile viewport", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 375, height: 812 },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
        "Version/15.0 Mobile/15E148 Safari/604.1",
    });
    const page = await context.newPage();
    await page.goto("/");
    // The create-room form is the primary panel visible to a first-time visitor
    // on mobile; its presence confirms the shell renders correctly at 375 px.
    await expect(page.getByTestId("create-room-form")).toBeVisible();
    await context.close();
  });

  test("a11y smoke: a skip-navigation link is present after page load", async ({
    page,
  }) => {
    await page.goto("/");
    // The skip link allows keyboard/AT users to bypass repeated nav content.
    // It must exist in the DOM regardless of whether it is visually hidden.
    const skipLink = page.locator(".skip-link");
    await expect(skipLink).toHaveCount(1);
  });
});

async function createAndJoinRoom(
  browser: Browser,
  baseURL: string | undefined,
  options: Readonly<{
    totalRounds?: number;
    /**
     * Runs right after the guest `Page` is created but before it navigates
     * anywhere — i.e. strictly before the guest's first WebSocket connects.
     * Lets a test install a `page.routeWebSocket()` interceptor (or similar)
     * that must govern the *first* socket (the one carrying live gameplay),
     * not just a later reconnect attempt.
     */
    beforeGuestJoin?: (guest: Page) => Promise<void>;
  }> = {},
): Promise<{
  host: Page;
  guest: Page;
  hostContext: BrowserContext;
  guestContext: BrowserContext;
  inviteUrl: string;
}> {
  const hostContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  if (options.beforeGuestJoin) {
    await options.beforeGuestJoin(guest);
  }

  await host.goto("/");
  await expect(host.getByTestId("create-room-form")).toBeVisible();
  await host.getByTestId("create-room-form").getByLabel("Your name").fill("Ada");
  await host.getByLabel("Total rounds").fill(String(options.totalRounds ?? 1));
  await host.getByRole("button", { name: "Create invite room" }).click();
  await expect(host.getByTestId("room-controls")).toBeVisible({
    timeout: ROOM_PHASE_TIMEOUT_MS,
  });
  await expect(host.getByRole("button", { name: "Start game" })).toBeDisabled();

  const inviteUrl = await host.locator("#room-invite-link").inputValue();

  await guest.goto(inviteUrl);
  await expect(guest.getByTestId("join-room-form")).toBeVisible();
  await expect(guest.getByTestId("create-room-form")).toHaveCount(0);
  await guest.getByTestId("join-room-form").getByLabel("Your name").fill("Grace");
  await guest.getByRole("button", { name: "Join as player B" }).click();
  await expect(guest.getByTestId("room-controls")).toBeVisible({
    timeout: ROOM_PHASE_TIMEOUT_MS,
  });
  await expect(guest.locator("#room-invite-link")).toHaveCount(0);

  return { host, guest, hostContext, guestContext, inviteUrl };
}

/**
 * Plays round 1 to settlement under the default player-entered-query flow:
 * roles are swapped, so the host (Ada) is the trader who enters the query
 * and the guest (Grace) makes the market.
 */
async function playDefaultQueryRoundToSettlement(host: Page, guest: Page) {
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
  await expect(host.getByTestId("item-panel")).not.toContainText("True value");

  await guest.getByRole("spinbutton", { name: "Spread width" }).fill("100");
  await guest.getByRole("button", { name: "Propose width" }).click();

  await expect(host.getByTestId("width-negotiation-panel")).toContainText(
    /Current width:?\s*100/,
    { timeout: ROOM_PHASE_TIMEOUT_MS },
  );
  await host.getByRole("button", { name: "Trade on width" }).click();

  await guest.getByRole("spinbutton", { name: "Ask" }).fill("3700");
  await expect(guest.getByRole("spinbutton", { name: "Bid" })).toHaveValue("3600");
  await guest.getByRole("button", { name: "Commit market" }).click();

  await expect(host.getByTestId("trade-action-panel")).toContainText(
    "Quote: 3,600 / 3,700",
    { timeout: ROOM_PHASE_TIMEOUT_MS },
  );
  await host.getByRole("button", { name: "Buy" }).click();

  await expect(host.getByTestId("settlement-panel")).toBeVisible({
    timeout: ROOM_PHASE_TIMEOUT_MS,
  });
  await expect(host.getByTestId("item-panel")).toContainText("True value");
  await expect(host.getByTestId("settlement-panel")).toContainText(
    "Ada trader PnL",
  );
}
