import { expect, test, type Browser, type Page } from "@playwright/test";

const ROOM_PHASE_TIMEOUT_MS = 15_000;

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
  options: Readonly<{ totalRounds?: number }> = {},
): Promise<{
  host: Page;
  guest: Page;
  inviteUrl: string;
}> {
  const hostContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

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

  return { host, guest, inviteUrl };
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
