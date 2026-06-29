import { NextResponse, type NextRequest } from "next/server";
import { commitRoundMarket } from "./round-store";
import {
  validateQuoteForWidth,
  validateRoles,
  type PlayerId,
  type Quote,
  type Roles,
} from "../lib/game";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await readRequestJson(request);
  const parsed = parseCommitMarketBody(body);

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const committed = commitRoundMarket({
    quote: parsed.quote,
    roles: parsed.roles,
    roundId: parsed.round_id,
    roundNumber: parsed.roundNumber,
  });

  if (!committed.ok) {
    if (committed.reason === "already_committed" || committed.reason === "settled") {
      return NextResponse.json(
        { error: "Round market is already committed." },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: "Round market could not be committed." },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}

async function readRequestJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function parseCommitMarketBody(body: unknown):
  | {
      ok: true;
      quote: Quote;
      roles: Roles;
      round_id: string;
      roundNumber: number;
      spreadWidth: number;
    }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Market commitment request is invalid." };
  }

  if (typeof body.round_id !== "string" || body.round_id.trim().length === 0) {
    return { ok: false, error: "Round id is required." };
  }

  if (
    typeof body.roundNumber !== "number" ||
    !Number.isInteger(body.roundNumber) ||
    body.roundNumber < 1
  ) {
    return { ok: false, error: "Round number is invalid." };
  }

  if (!isQuote(body.quote)) {
    return { ok: false, error: "Quote is invalid." };
  }

  if (typeof body.spreadWidth !== "number") {
    return { ok: false, error: "Spread width is invalid." };
  }

  const quoteValidation = validateQuoteForWidth(body.quote, body.spreadWidth);
  if (!quoteValidation.ok) {
    return { ok: false, error: quoteValidation.error };
  }

  if (!isRoles(body.roles)) {
    return { ok: false, error: "Roles are invalid." };
  }

  const rolesValidation = validateRoles(body.roles);
  if (!rolesValidation.ok) {
    return { ok: false, error: rolesValidation.error };
  }

  return {
    ok: true,
    quote: body.quote,
    roles: body.roles,
    round_id: body.round_id,
    roundNumber: body.roundNumber,
    spreadWidth: body.spreadWidth,
  };
}

function isQuote(value: unknown): value is Quote {
  return (
    isRecord(value) &&
    typeof value.bid === "number" &&
    typeof value.ask === "number"
  );
}

function isRoles(value: unknown): value is Roles {
  return (
    isRecord(value) &&
    isPlayerId(value.marketMaker) &&
    isPlayerId(value.trader)
  );
}

function isPlayerId(value: unknown): value is PlayerId {
  return value === "A" || value === "B";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
