import { describe, expect, it } from "vitest";

import { MIN_TURN_DURATION_MS } from "./game/types";
import { DEAD_SOCKET_RECOVERY_BUDGET_MS } from "./room-socket-supervisor";

/**
 * Pins the relationship between two constants that live in different
 * modules and would otherwise have no code-level connection to each
 * other: how long a disconnected player's client takes, worst case, to
 * notice its own dead socket and self-heal (`DEAD_SOCKET_RECOVERY_BUDGET_MS`
 * in room-socket-supervisor.ts) versus the shortest turn clock a player can
 * be on the hook for (`MIN_TURN_DURATION_MS`, currently choosingSide's 30s,
 * in game/types.ts).
 *
 * Nothing else in the codebase checks this. Before this test existed, a
 * routine Wi-Fi blip that killed a trader's socket right as the market
 * maker's quote landed could not be detected, let alone recovered from,
 * before the choosingSide clock expired — and because F-06 settles a
 * choosingSide timeout at whichever side is worse for the trader (PnL
 * bounded only by the item's true value, not a flat forfeit like the other
 * three phases), the cost of that gap was unbounded. See
 * `DEAD_SOCKET_RECOVERY_BUDGET_MS` for the detection/backoff/reconnect
 * arithmetic and `MIN_TURN_DURATION_MS` for why choosingSide is the phase
 * that matters.
 *
 * The margin requirement (2x, not just "less than") is deliberate: "fits
 * with 1ms to spare" is not a fix for a production system with real
 * network jitter. Either constant drifting — a heartbeat slowed down, a
 * turn phase shortened, a new shorter phase added to
 * `MIN_TURN_DURATION_MS`'s Math.min list — must fail this test before it
 * reaches production.
 */
const REQUIRED_SAFETY_FACTOR = 2;

describe("dead-socket recovery budget vs. shortest turn clock", () => {
  it("self-heals within the shortest turn duration", () => {
    expect(DEAD_SOCKET_RECOVERY_BUDGET_MS).toBeLessThan(MIN_TURN_DURATION_MS);
  });

  it("self-heals with at least a 2x safety margin, not just barely", () => {
    expect(DEAD_SOCKET_RECOVERY_BUDGET_MS * REQUIRED_SAFETY_FACTOR).toBeLessThanOrEqual(
      MIN_TURN_DURATION_MS,
    );
  });
});
