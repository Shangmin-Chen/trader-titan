import { NextResponse, type NextRequest } from "next/server";
import { settleCommittedRound } from "../round-store";
import { validateTradeSide } from "../../../src/lib/game";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await readRequestJson(request);
  const parsed = parseSettleRoundBody(body);

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const settled = settleCommittedRound(parsed.round_id, parsed.side);

  if (!settled) {
    return NextResponse.json(
      { error: "Round could not be settled." },
      { status: 409 },
    );
  }

  return NextResponse.json(settled);
}

async function readRequestJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function parseSettleRoundBody(body: unknown):
  | {
      ok: true;
      round_id: string;
      side: "BUY" | "SELL";
    }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Settlement request is invalid." };
  }

  if (typeof body.round_id !== "string" || body.round_id.trim().length === 0) {
    return { ok: false, error: "Round id is required." };
  }

  if (!validateTradeSide(body.side)) {
    return { ok: false, error: "Trade side is invalid." };
  }

  return {
    ok: true,
    round_id: body.round_id,
    side: body.side,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
