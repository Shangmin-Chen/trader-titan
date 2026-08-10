"use client";

import { useEffect, useState } from "react";

export type TurnCountdownProps = {
  /**
   * Absolute server-stamped deadline in Unix milliseconds (PublicRoomGameState's
   * `turnDeadlineMs` on the four turn-clocked phases). The countdown always
   * renders relative to this absolute value and the browser's own clock -
   * never a server-sent remaining-seconds integer, which would desync on
   * every reconnect. See specs/room-protocol.md.
   */
  turnDeadlineMs: number;
};

const TICK_MS = 250;
const URGENT_THRESHOLD_MS = 10_000;

function remainingSeconds(turnDeadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((turnDeadlineMs - nowMs) / 1000));
}

/**
 * Renders a live countdown to `turnDeadlineMs`. Purely a rendering clock -
 * it never decides expiry itself; the server (Worker alarm) is the only
 * authority on when a turn actually expires. This can read "0s" for a few
 * hundred ms before the next room snapshot lands with the phase change.
 */
export function TurnCountdown({ turnDeadlineMs }: TurnCountdownProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const secondsLeft = remainingSeconds(turnDeadlineMs, nowMs);
  const urgent = turnDeadlineMs - nowMs <= URGENT_THRESHOLD_MS;

  return (
    <div
      className="turn-countdown"
      data-testid="turn-countdown"
      data-urgent={urgent ? "true" : "false"}
      role="timer"
    >
      <span aria-hidden="true">⏱</span>
      <span>{secondsLeft}s</span>
    </div>
  );
}
