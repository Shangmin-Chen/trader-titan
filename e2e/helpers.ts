import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const ROOM_PHASE_TIMEOUT_MS = 15_000;

/**
 * Clicks "Create invite room" and waits for the host's room controls.
 *
 * The whole e2e suite shares one `wrangler dev` origin, so parallel specs
 * starting together can hit the worker's per-IP room-creation rate limit
 * (10 per rolling 60s — see ROOM_CREATION_RATE_LIMIT_* in
 * src/api/request-guards.ts). A rejected request consumes no limiter slot,
 * so poll until the rolling window frees up rather than failing the spec.
 */
export async function createInviteRoomAndWaitForControls(host: Page): Promise<void> {
  await expect(async () => {
    const createButton = host.getByRole("button", { name: "Create invite room" });

    if ((await createButton.count()) === 0) {
      // A previous attempt already landed us in the room view; the final
      // assertion below owns the visibility check from here.
      return;
    }

    await createButton.click();
    await expect(host.getByTestId("room-controls")).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 90_000 });

  await expect(host.getByTestId("room-controls")).toBeVisible();
}

export async function createAndJoinRoom(
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
  await createInviteRoomAndWaitForControls(host);
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
 * Extracts the room id from an invite URL of the form
 * "http://.../?room=room-xxxxxxxx".
 */
export function roomIdFromInviteUrl(inviteUrl: string): string {
  const roomId = new URL(inviteUrl).searchParams.get("room");

  if (roomId === null) {
    throw new Error(`Invite URL did not contain a room id: ${inviteUrl}`);
  }

  return roomId;
}

