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
    await expect(host.getByTestId("item-panel")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await expect(host.getByTestId("item-panel")).not.toContainText("True value");

    await host.getByLabel("Spread width").fill("100");
    await host.getByRole("button", { name: "Propose width" }).click();

    await expect(guest.getByTestId("width-negotiation-panel")).toContainText(
      "Current width: 100",
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );
    await guest.getByRole("button", { name: "Trade on width" }).click();

    await host.getByLabel("Ask").fill("3700");
    await expect(host.getByLabel("Bid")).toHaveValue("3600");
    await host.getByRole("button", { name: "Commit market" }).click();

    await expect(guest.getByTestId("trade-action-panel")).toContainText(
      "Quote: 3,600 / 3,700",
      { timeout: ROOM_PHASE_TIMEOUT_MS },
    );
    await guest.getByRole("button", { name: "Buy" }).click();

    await expect(host.getByTestId("settlement-panel")).toBeVisible({
      timeout: ROOM_PHASE_TIMEOUT_MS,
    });
    await expect(host.getByTestId("item-panel")).toContainText("True value");
    await expect(host.getByTestId("settlement-panel")).toContainText("Grace trader PnL");

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
});

async function createAndJoinRoom(
  browser: Browser,
  baseURL: string | undefined,
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
  await host.getByLabel("Total rounds").fill("1");
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
