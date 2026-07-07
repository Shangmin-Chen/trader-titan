import { expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const SCREENSHOTS_DIR = "/Users/shangminchen/.gemini/antigravity-cli/brain/47ae34cc-9c40-4334-96ed-56720caf70f1/screenshots";

// Ensure the directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

test.describe("Visual Audit Multi-Player Flows", () => {
  test("Desktop Flow (1280x800)", async ({ browser, baseURL }) => {
    test.setTimeout(90000);
    const viewport = { width: 1280, height: 800 };
    const prefix = "desktop";

    const hostContext = await browser.newContext({ baseURL, viewport });
    const guestContext = await browser.newContext({ baseURL, viewport });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    // 1. Lobby Phase
    await host.goto("/");
    await expect(host.getByTestId("create-room-form")).toBeVisible();
    await host.getByTestId("create-room-form").getByLabel("Your name").fill("Ada");
    await host.getByLabel("Total rounds").fill("1");
    
    // Select Amazon mode; player-entered queries are the default flow.
    await host.getByRole("combobox", { name: "Game mode" }).click();
    await host.locator("li.custom-select__item").filter({ hasText: "Amazon" }).click();
    
    // Create the room
    await host.getByRole("button", { name: "Create invite room" }).click();
    await expect(host.getByTestId("room-controls")).toBeVisible({ timeout: 15000 });
    
    const inviteUrl = await host.locator("#room-invite-link").inputValue();

    await guest.goto(inviteUrl);
    await expect(guest.getByTestId("join-room-form")).toBeVisible();
    await guest.getByTestId("join-room-form").getByLabel("Your name").fill("Grace");
    await guest.getByRole("button", { name: "Join as player B" }).click();
    await expect(guest.getByTestId("room-controls")).toBeVisible({ timeout: 15000 });

    // Both in Lobby - Take screenshots
    await host.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-01-lobby-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-01-lobby-guest.png`) });

    // 2. Start Game -> Setup / Query Input Phase
    await host.getByRole("button", { name: "Start game" }).click();

    // Wait for the custom query form to be visible on both pages
    await expect(host.getByTestId("custom-amazon-query-form")).toBeVisible({ timeout: 15000 });
    await expect(guest.getByTestId("custom-amazon-query-form")).toBeVisible({ timeout: 15000 });

    // Now check which one is enabled
    const hostEnabled = await host.getByLabel("Search Term / Product Name").isEnabled();
    const traderPage = hostEnabled ? host : guest;

    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-02-setup-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-02-setup-guest.png`) });

    await traderPage.getByLabel("Search Term / Product Name").fill("gaming mouse");
    await traderPage.getByRole("button", { name: "Submit & Scrape Price" }).click();

    // Wait for generation to complete and enter width proposal phase
    await expect(host.getByTestId("item-panel")).toBeVisible({ timeout: 25000 });
    await host.waitForTimeout(1000);

    // 3. Spread Width Negotiation Phase
    // Take screenshots of initial width proposal phase
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-init-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-init-guest.png`) });

    // Propose initial width
    const hostMakerEnabled = await host.getByRole("spinbutton", { name: "Spread width", exact: true }).isEnabled();
    const makerPage = hostMakerEnabled ? host : guest;
    const negotiatorPage = makerPage === host ? guest : host;

    await makerPage.getByRole("spinbutton", { name: "Spread width", exact: true }).fill("100");
    await makerPage.getByRole("button", { name: "Propose width" }).click();

    // Negotiator receives proposal -> Counter-proposal / Tighten Width
    await expect(negotiatorPage.getByTestId("width-negotiation-panel")).toContainText("Current width100", { timeout: 15000 });
    await negotiatorPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-proposal-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-proposal-guest.png`) });

    // Counter propose: tighten width to 60 (roles will swap!)
    await negotiatorPage.getByRole("spinbutton", { name: "Tighter width", exact: true }).fill("60");
    await negotiatorPage.getByRole("button", { name: "Tighten width" }).click();

    // Maker (who is now the negotiator/trader) receives tightened proposal (60)
    await expect(makerPage.getByTestId("width-negotiation-panel")).toContainText("Current width60", { timeout: 15000 });
    await makerPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-counter-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-counter-guest.png`) });

    // Maker (makerPage) accepts the tighter width (60)
    await makerPage.getByRole("button", { name: "Trade on width" }).click();

    // 4. Market Commitment Phase
    // Proposer (now negotiatorPage) sees Market Commitment Panel (inputs for Bid/Ask)
    await expect(negotiatorPage.getByRole("spinbutton", { name: "Ask", exact: true })).toBeVisible({ timeout: 15000 });
    await negotiatorPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-04-commitment-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-04-commitment-guest.png`) });

    // Proposer commits market (e.g. Ask = 300, Bid = 240 since width is 60)
    const currentAsk = await negotiatorPage.getByRole("spinbutton", { name: "Ask", exact: true }).inputValue();
    const askVal = parseFloat(currentAsk) || 300;
    await negotiatorPage.getByRole("spinbutton", { name: "Ask", exact: true }).fill(askVal.toString());
    await negotiatorPage.getByRole("button", { name: "Commit market" }).click();

    // 5. Trade Action Phase
    // Trader (now makerPage) sees Trade Action Panel (Buy/Sell buttons)
    await expect(makerPage.getByTestId("trade-action-panel")).toBeVisible({ timeout: 15000 });
    await makerPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-05-tradeaction-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-05-tradeaction-guest.png`) });

    // Trader executes trade (Buy)
    await makerPage.getByRole("button", { name: "Buy" }).click();

    // 6. Settlement & Scraper Breakdown Phase
    await expect(host.getByTestId("settlement-panel")).toBeVisible({ timeout: 15000 });
    await host.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-06-settlement-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-06-settlement-guest.png`) });

    await hostContext.close();
    await guestContext.close();
  });

  test("Mobile Flow (375x812)", async ({ browser, baseURL }) => {
    test.setTimeout(90000);
    const viewport = { width: 375, height: 812 };
    const prefix = "mobile";

    const hostContext = await browser.newContext({
      baseURL,
      viewport,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
    });
    const guestContext = await browser.newContext({
      baseURL,
      viewport,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
    });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    // 1. Lobby Phase
    await host.goto("/");
    await expect(host.getByTestId("create-room-form")).toBeVisible();
    await host.getByTestId("create-room-form").getByLabel("Your name").fill("Ada");
    await host.getByLabel("Total rounds").fill("1");
    
    await host.getByRole("combobox", { name: "Game mode" }).click();
    await host.locator("li.custom-select__item").filter({ hasText: "Amazon" }).click();
    
    await host.getByRole("button", { name: "Create invite room" }).click();
    await expect(host.getByTestId("room-controls")).toBeVisible({ timeout: 15000 });
    
    const inviteUrl = await host.locator("#room-invite-link").inputValue();

    await guest.goto(inviteUrl);
    await expect(guest.getByTestId("join-room-form")).toBeVisible();
    await guest.getByTestId("join-room-form").getByLabel("Your name").fill("Grace");
    await guest.getByRole("button", { name: "Join as player B" }).click();
    await expect(guest.getByTestId("room-controls")).toBeVisible({ timeout: 15000 });

    await host.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-01-lobby-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-01-lobby-guest.png`) });

    // 2. Start Game -> Setup / Query Input Phase
    await host.getByRole("button", { name: "Start game" }).click();

    // Wait for the custom query form to be visible on both pages
    await expect(host.getByTestId("custom-amazon-query-form")).toBeVisible({ timeout: 15000 });
    await expect(guest.getByTestId("custom-amazon-query-form")).toBeVisible({ timeout: 15000 });

    // Now check which one is enabled
    const hostEnabled = await host.getByLabel("Search Term / Product Name").isEnabled();
    const traderPage = hostEnabled ? host : guest;

    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-02-setup-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-02-setup-guest.png`) });

    await traderPage.getByLabel("Search Term / Product Name").fill("gaming mouse");
    await traderPage.getByRole("button", { name: "Submit & Scrape Price" }).click();

    await expect(host.getByTestId("item-panel")).toBeVisible({ timeout: 25000 });
    await host.waitForTimeout(1000);

    // 3. Spread Width Negotiation Phase
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-init-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-init-guest.png`) });

    const hostMakerEnabled = await host.getByRole("spinbutton", { name: "Spread width", exact: true }).isEnabled();
    const makerPage = hostMakerEnabled ? host : guest;
    const negotiatorPage = makerPage === host ? guest : host;

    await makerPage.getByRole("spinbutton", { name: "Spread width", exact: true }).fill("100");
    await makerPage.getByRole("button", { name: "Propose width" }).click();

    await expect(negotiatorPage.getByTestId("width-negotiation-panel")).toContainText("Current width100", { timeout: 15000 });
    await negotiatorPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-proposal-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-proposal-guest.png`) });

    await negotiatorPage.getByRole("spinbutton", { name: "Tighter width", exact: true }).fill("60");
    await negotiatorPage.getByRole("button", { name: "Tighten width" }).click();

    await expect(makerPage.getByTestId("width-negotiation-panel")).toContainText("Current width60", { timeout: 15000 });
    await makerPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-counter-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-03-negotiate-counter-guest.png`) });

    await makerPage.getByRole("button", { name: "Trade on width" }).click();

    // 4. Market Commitment Phase
    await expect(negotiatorPage.getByRole("spinbutton", { name: "Ask", exact: true })).toBeVisible({ timeout: 15000 });
    await negotiatorPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-04-commitment-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-04-commitment-guest.png`) });

    const currentAsk = await negotiatorPage.getByRole("spinbutton", { name: "Ask", exact: true }).inputValue();
    const askVal = parseFloat(currentAsk) || 300;
    await negotiatorPage.getByRole("spinbutton", { name: "Ask", exact: true }).fill(askVal.toString());
    await negotiatorPage.getByRole("button", { name: "Commit market" }).click();

    // 5. Trade Action Phase
    await expect(makerPage.getByTestId("trade-action-panel")).toBeVisible({ timeout: 15000 });
    await makerPage.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-05-tradeaction-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-05-tradeaction-guest.png`) });

    await makerPage.getByRole("button", { name: "Buy" }).click();

    // 6. Settlement & Scraper Breakdown Phase
    await expect(host.getByTestId("settlement-panel")).toBeVisible({ timeout: 15000 });
    await host.waitForTimeout(1000);
    await host.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-06-settlement-host.png`) });
    await guest.screenshot({ path: path.join(SCREENSHOTS_DIR, `${prefix}-06-settlement-guest.png`) });

    await hostContext.close();
    await guestContext.close();
  });
});
