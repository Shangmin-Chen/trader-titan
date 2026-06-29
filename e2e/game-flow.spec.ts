import { expect, test, type Locator, type Page } from "@playwright/test";

const generatedItem = {
  round_id: "round-e2e",
  item_title: "Stacked subway tiles in a station wall",
  category: "Fermi Math & Geometry",
  context_clue: "Estimate the number of visible rectangular tiles on one wall.",
};
const trueValue = 300;

type CommittedMarket = {
  quote: { bid: number; ask: number };
  roles: { marketMaker: "A" | "B"; trader: "A" | "B" };
  roundNumber: number;
  spreadWidth: number;
};

type MockGameApiOptions = {
  failFirstCommit?: boolean;
  failFirstSettlement?: boolean;
};

async function mockGameApi(page: Page, options: MockGameApiOptions = {}) {
  let committedMarket: CommittedMarket | null = null;
  let commitAttempts = 0;
  let settlementAttempts = 0;

  await page.route("**/api/generate-item", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(await request.postDataJSON()).toMatchObject({
      mode: "Chaos Quant",
    });

    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify(generatedItem),
    });
  });

  await page.route("**/api/commit-market", async (route) => {
    const body = await route.request().postDataJSON();
    expect(body.round_id).toBe(generatedItem.round_id);
    expect(Math.abs(body.quote.ask - body.quote.bid - body.spreadWidth)).toBeLessThan(
      1e-9,
    );

    commitAttempts += 1;
    if (options.failFirstCommit && commitAttempts === 1) {
      await route.fulfill({
        contentType: "application/json",
        status: 503,
        body: JSON.stringify({ error: "Market commit failed for test." }),
      });
      return;
    }

    committedMarket = {
      quote: body.quote,
      roles: body.roles,
      roundNumber: body.roundNumber,
      spreadWidth: body.spreadWidth,
    };

    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/settle-round", async (route) => {
    const body = await route.request().postDataJSON();
    expect(body.round_id).toBe(generatedItem.round_id);

    settlementAttempts += 1;
    if (options.failFirstSettlement && settlementAttempts === 1) {
      await route.fulfill({
        contentType: "application/json",
        status: 503,
        body: JSON.stringify({ error: "Settlement failed for test." }),
      });
      return;
    }

    expect(committedMarket).not.toBeNull();

    if (committedMarket === null) {
      await route.fulfill({
        contentType: "application/json",
        status: 409,
        body: JSON.stringify({ error: "Round could not be settled." }),
      });
      return;
    }

    const side = body.side as "BUY" | "SELL";
    const transactionPrice =
      side === "BUY" ? committedMarket.quote.ask : committedMarket.quote.bid;
    const traderPnL =
      side === "BUY"
        ? trueValue - committedMarket.quote.ask
        : committedMarket.quote.bid - trueValue;

    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({
        item: {
          ...generatedItem,
          true_value: trueValue,
        },
        settlement: {
          itemTitle: generatedItem.item_title,
          marketMaker: committedMarket.roles.marketMaker,
          marketMakerPnL: -traderPnL,
          roundNumber: committedMarket.roundNumber,
          side,
          trader: committedMarket.roles.trader,
          traderPnL,
          transactionPrice,
          trueValue,
        },
      }),
    });
  });
}

async function startOneRoundGame(page: Page, options?: MockGameApiOptions) {
  await mockGameApi(page, options);
  await page.goto("/");

  await page.getByLabel("Player A").fill("Ava");
  await page.getByLabel("Player B").fill("Ben");
  await page.getByLabel("Total rounds").fill("1");
  await page.getByRole("button", { name: "Start game" }).click();

  await expect(page.getByTestId("item-panel")).toContainText(
    generatedItem.item_title,
  );
  await expect(page.getByTestId("item-panel")).not.toContainText("True value");
  await expect(page.getByTestId("item-panel")).not.toContainText(String(trueValue));
  await expect(page.getByRole("heading", { name: "Ava" })).toBeVisible();
}

async function proposeWidth(page: Page, width: string) {
  await page.getByLabel("Spread width").fill(width);
  await page.getByRole("button", { name: "Propose width" }).click();
}

async function tightenWidth(page: Page, width: string) {
  await page.getByLabel("Tighter width").fill(width);
  await page.getByRole("button", { name: "Tighten width" }).click();
}

async function commitMarketFromAsk(page: Page, ask: string, expectedBid: string) {
  await page.getByLabel("Ask").fill(ask);
  await expect(page.getByLabel("Bid")).toHaveValue(expectedBid);
  await page.getByRole("button", { name: "Commit market" }).click();
}

async function commitMarketFromBid(page: Page, bid: string, expectedAsk: string) {
  await page.getByLabel("Bid").fill(bid);
  await expect(page.getByLabel("Ask")).toHaveValue(expectedAsk);
  await page.getByRole("button", { name: "Commit market" }).click();
}

async function expectDefinition(
  container: Locator,
  term: string,
  value: string | RegExp,
) {
  const row = container.locator("dl > div").filter({ hasText: term });

  await expect(row).toContainText(value);
}

test.describe("Trader Titan game flow", () => {
  test("completes the A 500, B 200, A trades, B sets 200 / 400 BUY flow", async ({ page }) => {
    await startOneRoundGame(page);
    await proposeWidth(page, "500");
    await tightenWidth(page, "200");

    const widthPanel = page.getByTestId("width-negotiation-panel");
    await expect(widthPanel).toContainText("Current width: 200");
    await expectDefinition(widthPanel, "Width owner", "Ben");
    await expectDefinition(widthPanel, "Decision", "Ava");
    await expect(page.getByTestId("item-panel")).not.toContainText("True value");

    await page.getByRole("button", { name: "Trade on width" }).click();
    await commitMarketFromAsk(page, "400", "200");

    const tradePanel = page.getByTestId("trade-action-panel");
    await expect(tradePanel).toContainText("Quote: 200 / 400");
    await expectDefinition(tradePanel, "Market maker", "Ben");
    await expectDefinition(tradePanel, "Trader", "Ava");

    await page.getByRole("button", { name: "Buy" }).click();

    const settlement = page.getByTestId("settlement-panel");
    await expect(settlement).toBeVisible();
    await expect(page.getByTestId("item-panel")).toContainText("True value");
    await expect(page.getByTestId("item-panel")).toContainText(String(trueValue));
    await expectDefinition(settlement, "Transaction", "Buy at 400");
    await expectDefinition(settlement, "Ava trader PnL", "-100");
    await expectDefinition(settlement, "Ben market maker PnL", "+100");

    await page.getByRole("button", { name: "End game" }).click();
    const gameOver = page.getByTestId("game-over-panel");
    await expect(gameOver).toContainText("Ben wins");
    await expectDefinition(gameOver, "Ava", "-100");
    await expectDefinition(gameOver, "Ben", "+100");

    await page.getByRole("button", { name: "Reset game" }).click();
    await expect(page.getByTestId("setup-form")).toBeVisible();
    await expect(page.getByLabel("Player A")).toHaveValue("Player A");
    await expect(page.getByLabel("Player B")).toHaveValue("Player B");
  });

  test("supports trading on the opening width and auto-fills ask from bid", async ({ page }) => {
    await startOneRoundGame(page);
    await proposeWidth(page, "500");

    const widthPanel = page.getByTestId("width-negotiation-panel");
    await expectDefinition(widthPanel, "Width owner", "Ava");
    await expectDefinition(widthPanel, "Decision", "Ben");

    await page.getByRole("button", { name: "Trade on width" }).click();
    await commitMarketFromBid(page, "250", "750");

    const tradePanel = page.getByTestId("trade-action-panel");
    await expect(tradePanel).toContainText("Quote: 250 / 750");
    await expectDefinition(tradePanel, "Market maker", "Ava");
    await expectDefinition(tradePanel, "Trader", "Ben");

    await page.getByRole("button", { name: "Sell" }).click();

    const settlement = page.getByTestId("settlement-panel");
    await expectDefinition(settlement, "Transaction", "Sell at 250");
    await expectDefinition(settlement, "Ben trader PnL", "-50");
    await expectDefinition(settlement, "Ava market maker PnL", "+50");
  });

  test("blocks invalid width proposals before market configuration", async ({ page }) => {
    await startOneRoundGame(page);

    await proposeWidth(page, "0");
    await expect(page.getByTestId("spread-width-form").getByRole("alert")).toHaveText(
      "Spread width must be greater than 0.",
    );
    await expect(page.getByTestId("width-negotiation-panel")).toBeHidden();

    await proposeWidth(page, "500");
    const widthPanel = page.getByTestId("width-negotiation-panel");
    await expect(widthPanel).toBeVisible();

    await tightenWidth(page, "700");
    await expect(widthPanel.getByTestId("spread-width-form").getByRole("alert")).toHaveText(
      "New spread width must be tighter than current width.",
    );
    await expectDefinition(widthPanel, "Width owner", "Ava");
    await expectDefinition(widthPanel, "Decision", "Ben");
    await expect(widthPanel).toContainText("Current width: 500");
    await expect(page.getByTestId("market-range-form")).toBeHidden();
    await expect(page.getByTestId("settlement-panel")).toBeHidden();
  });

  test("keeps market configuration open after a failed commit", async ({ page }) => {
    await startOneRoundGame(page, { failFirstCommit: true });
    await proposeWidth(page, "500");
    await tightenWidth(page, "200");
    await page.getByRole("button", { name: "Trade on width" }).click();

    await commitMarketFromAsk(page, "400", "200");

    await expect(page.locator("p[role='alert']")).toHaveText(
      "Market commit failed for test.",
    );
    await expect(page.getByTestId("market-range-form")).toBeVisible();
    await expect(page.getByTestId("trade-action-panel")).toBeHidden();

    await page.getByRole("button", { name: "Commit market" }).click();
    const tradePanel = page.getByTestId("trade-action-panel");
    await expect(tradePanel).toContainText("Quote: 200 / 400");
    await expectDefinition(tradePanel, "Market maker", "Ben");
    await expectDefinition(tradePanel, "Trader", "Ava");
  });

  test("returns to side choice after a failed settlement and allows retry", async ({ page }) => {
    await startOneRoundGame(page, { failFirstSettlement: true });
    await proposeWidth(page, "500");
    await tightenWidth(page, "200");
    await page.getByRole("button", { name: "Trade on width" }).click();
    await commitMarketFromAsk(page, "400", "200");

    await page.getByRole("button", { name: "Buy" }).click();

    await expect(page.getByTestId("trade-action-panel")).toBeVisible();
    await expect(page.locator("p[role='alert']")).toHaveText(
      "Settlement failed for test.",
    );
    const tradePanel = page.getByTestId("trade-action-panel");
    await expect(tradePanel).toContainText("Quote: 200 / 400");
    await expectDefinition(tradePanel, "Market maker", "Ben");
    await expectDefinition(tradePanel, "Trader", "Ava");
    await expect(page.getByTestId("item-panel")).not.toContainText("True value");

    await page.getByRole("button", { name: "Buy" }).click();
    const settlement = page.getByTestId("settlement-panel");
    await expect(settlement).toBeVisible();
    await expectDefinition(settlement, "Transaction", "Buy at 400");
    await expectDefinition(settlement, "Ava trader PnL", "-100");
    await expectDefinition(settlement, "Ben market maker PnL", "+100");
    await expect(page.getByTestId("item-panel")).toContainText("True value");
  });
});
