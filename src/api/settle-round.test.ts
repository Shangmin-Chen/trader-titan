import type { NextRequest } from "next/server";
import { afterEach } from "vitest";
import {
  clearRoundStoreForTests,
  commitRoundMarket,
  storeGeneratedRound,
} from "./round-store";
import { POST } from "./settle-round";

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/settle-round", {
    method: "POST",
    body: JSON.stringify(body),
  }) as NextRequest;
}

function rawRequest(body: string): NextRequest {
  return new Request("http://localhost/api/settle-round", {
    method: "POST",
    body,
  }) as NextRequest;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

afterEach(() => {
  clearRoundStoreForTests();
});

describe("POST /api/settle-round", () => {
  it("reveals true value only after a market is committed and computes PnL from server terms", async () => {
    const publicItem = storeGeneratedRound({
      item_title: "Cards in a deck",
      category: "Chaos Quant",
      context_clue: "Use a standard French-suited deck without jokers.",
      true_value: 52,
    });

    expect(publicItem).not.toHaveProperty("true_value");
    expect(
      commitRoundMarket({
        quote: { bid: 40, ask: 50 },
        roles: { marketMaker: "A", trader: "B" },
        roundId: publicItem.round_id,
        roundNumber: 1,
      }),
    ).toEqual({ ok: true });

    const response = await POST(
      request({
        round_id: publicItem.round_id,
        side: "BUY",
      }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      item: {
        ...publicItem,
        true_value: 52,
      },
      settlement: {
        itemTitle: "Cards in a deck",
        marketMaker: "A",
        marketMakerPnL: -2,
        roundNumber: 1,
        side: "BUY",
        trader: "B",
        traderPnL: 2,
        transactionPrice: 50,
        trueValue: 52,
      },
    });
  });

  it("returns the same settlement on retries after the round has settled", async () => {
    const publicItem = storeGeneratedRound({
      item_title: "Cards in a deck",
      category: "Chaos Quant",
      context_clue: "Use a standard French-suited deck without jokers.",
      true_value: 52,
    });

    expect(
      commitRoundMarket({
        quote: { bid: 40, ask: 50 },
        roles: { marketMaker: "A", trader: "B" },
        roundId: publicItem.round_id,
        roundNumber: 1,
      }),
    ).toEqual({ ok: true });

    const first = await POST(
      request({
        round_id: publicItem.round_id,
        side: "BUY",
      }),
    );
    const retryWithDifferentSide = await POST(
      request({
        round_id: publicItem.round_id,
        side: "SELL",
      }),
    );

    expect(first.status).toBe(200);
    expect(retryWithDifferentSide.status).toBe(200);
    expect(await readJson(retryWithDifferentSide)).toEqual(await readJson(first));
  });

  it("rejects premature settlement before the market is committed", async () => {
    const publicItem = storeGeneratedRound({
      item_title: "Cards in a deck",
      category: "Chaos Quant",
      context_clue: "Use a standard French-suited deck without jokers.",
      true_value: 52,
    });

    const response = await POST(
      request({
        round_id: publicItem.round_id,
        side: "BUY",
      }),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: "Round could not be settled.",
    });
  });

  it("rejects invalid settlement requests", async () => {
    const response = await POST(
      request({
        round_id: "missing",
        side: "HOLD",
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Trade side is invalid." });
  });

  it("rejects malformed or non-object request bodies", async () => {
    const malformed = await POST(rawRequest("{not-json"));
    const nullBody = await POST(request(null));

    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toEqual({
      error: "Settlement request is invalid.",
    });

    expect(nullBody.status).toBe(400);
    expect(await readJson(nullBody)).toEqual({
      error: "Settlement request is invalid.",
    });
  });

  it("returns 409 for unknown rounds", async () => {
    const response = await POST(
      request({
        round_id: "missing",
        side: "SELL",
      }),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({ error: "Round could not be settled." });
  });
});
