import type { NextRequest } from "next/server";
import { afterEach } from "vitest";
import {
  clearRoundStoreForTests,
  commitRoundMarket,
  settleCommittedRound,
  storeGeneratedRound,
} from "../round-store";
import type { Quote, Roles } from "../../../src/lib/game";
import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/commit-market", {
    method: "POST",
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

afterEach(() => {
  clearRoundStoreForTests();
});

describe("POST /api/commit-market", () => {
  it("commits a valid market for an existing round", async () => {
    const publicItem = storeGeneratedRound({
      item_title: "Cards in a deck",
      category: "Chaos Quant",
      context_clue: "Use a standard French-suited deck without jokers.",
      true_value: 52,
    });

    const response = await POST(
      request({
        quote: { bid: 40, ask: 50 },
        roles: { marketMaker: "A", trader: "B" },
        round_id: publicItem.round_id,
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("rejects invalid quotes before committing a market", async () => {
    const response = await POST(
      request({
        quote: { bid: 50, ask: 50 },
        roles: { marketMaker: "A", trader: "A" },
        round_id: "round",
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      error: "Quote bid must be less than ask.",
    });
  });

  it("rejects same-player roles", async () => {
    const response = await POST(
      request({
        quote: { bid: 40, ask: 50 },
        roles: { marketMaker: "A", trader: "A" },
        round_id: "round",
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      error: "Market maker and trader must be different players.",
    });
  });

  it("rejects malformed role payloads", async () => {
    const response = await POST(
      request({
        quote: { bid: 40, ask: 50 },
        roles: { marketMaker: "A", trader: "C" },
        round_id: "round",
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      error: "Roles are invalid.",
    });
  });

  it("rejects markets that do not match the accepted spread width", async () => {
    const response = await POST(
      request({
        quote: { bid: 40, ask: 60 },
        roles: { marketMaker: "A", trader: "B" },
        round_id: "round",
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      error: "Bid and ask must match the accepted spread width.",
    });
  });

  it("allows identical commit retries", async () => {
    const publicItem = storeGeneratedRound({
      item_title: "Cards in a deck",
      category: "Chaos Quant",
      context_clue: "Use a standard French-suited deck without jokers.",
      true_value: 52,
    });
    const body = {
      quote: { bid: 40, ask: 50 },
      roles: { marketMaker: "A", trader: "B" },
      round_id: publicItem.round_id,
      roundNumber: 1,
      spreadWidth: 10,
    };

    const first = await POST(request(body));
    const retry = await POST(request(body));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await readJson(retry)).toEqual({ ok: true });
  });

  it("rejects different second commitments and preserves the first market for settlement", async () => {
    const publicItem = storeGeneratedRound({
      item_title: "Cards in a deck",
      category: "Chaos Quant",
      context_clue: "Use a standard French-suited deck without jokers.",
      true_value: 52,
    });

    const first = await POST(
      request({
        quote: { bid: 40, ask: 50 },
        roles: { marketMaker: "A", trader: "B" },
        round_id: publicItem.round_id,
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );
    const second = await POST(
      request({
        quote: { bid: 10, ask: 20 },
        roles: { marketMaker: "B", trader: "A" },
        round_id: publicItem.round_id,
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );
    const settlement = settleCommittedRound(publicItem.round_id, "BUY");

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await readJson(second)).toEqual({
      error: "Round market is already committed.",
    });
    expect(settlement?.settlement).toMatchObject({
      marketMaker: "A",
      trader: "B",
      transactionPrice: 50,
      traderPnL: 2,
    });
  });

  it("stores committed market terms by value", async () => {
    const publicItem = storeGeneratedRound({
      item_title: "Cards in a deck",
      category: "Chaos Quant",
      context_clue: "Use a standard French-suited deck without jokers.",
      true_value: 52,
    });
    const quote: Quote = { bid: 40, ask: 50 };
    const roles: Roles = {
      marketMaker: "A",
      trader: "B",
    };

    const commit = commitRoundMarket({
      quote,
      roles,
      roundId: publicItem.round_id,
      roundNumber: 1,
    });
    quote.ask = 1_000;
    roles.marketMaker = "B";
    const settlement = settleCommittedRound(publicItem.round_id, "BUY");

    expect(commit).toEqual({ ok: true });
    expect(settlement?.settlement).toMatchObject({
      marketMaker: "A",
      trader: "B",
      transactionPrice: 50,
      traderPnL: 2,
    });
  });

  it("returns 404 for unknown rounds", async () => {
    const response = await POST(
      request({
        quote: { bid: 40, ask: 50 },
        roles: { marketMaker: "A", trader: "B" },
        round_id: "missing",
        roundNumber: 1,
        spreadWidth: 10,
      }),
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      error: "Round market could not be committed.",
    });
  });
});
