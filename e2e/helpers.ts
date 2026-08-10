import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const ROOM_PHASE_TIMEOUT_MS = 15_000;

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

/**
 * Test-only affordance (see E2E_FAST_FORWARD_TURN_OFFSET_MS in
 * src/worker/index.ts): fast-forwards a room's currently-armed F-05 turn
 * deadline to a few seconds from now, so a Playwright test can exercise a
 * genuine clock expiry without sleeping out the real 30-60s duration (see
 * *_TURN_DURATION_MS in src/lib/game/types.ts). Everything downstream of
 * the deadline still runs for real: the Durable Object alarm, the
 * TURN_EXPIRED transition, persistence, and the WebSocket broadcast that
 * updates `page`'s own rendered state.
 *
 * Reads the caller's own stored room-session credential straight out of
 * `page`'s sessionStorage (the same one src/lib/room-client.ts's
 * saveRoomSession/loadRoomSession read and write under the
 * "trader-titan.room-session.v1:<roomId>" key) rather than threading a
 * credential through test code, so this works identically for a host or a
 * guest page. Only reachable against a dev/test server (the Worker 404s
 * this route unless WORKER_ITEM_PROVIDER is set — see wrangler dev's
 * --var in playwright.config.ts), never in a real deploy.
 */
export async function fastForwardTurnClock(
  page: Page,
  roomId: string,
): Promise<void> {
  const result = await page.evaluate(async (id) => {
    const sessionKey = `trader-titan.room-session.v1:${id}`;
    const raw = window.sessionStorage.getItem(sessionKey);

    if (raw === null) {
      return { ok: false as const, status: 0, body: `No room session found under ${sessionKey}` };
    }

    const session = JSON.parse(raw) as { token: unknown };
    const response = await fetch(`/api/rooms/${id}/test-expire-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: session.token }),
    });
    const body: unknown = await response.json();

    return { ok: response.ok, status: response.status, body };
  }, roomId);

  if (!result.ok) {
    throw new Error(
      `fastForwardTurnClock failed (status ${result.status}): ${JSON.stringify(result.body)}`,
    );
  }
}
