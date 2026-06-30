"use client";

import React from "react";

export type TurnBannerProps = {
  /** Whether it is the local player's turn to act. */
  isYourTurn: boolean;
  /** Display name of the player being waited on (when not your turn). */
  waitingForName?: string;
  /**
   * Optional intent tint when it IS your turn: "buy" / "sell" pick up the
   * matching color hooks; defaults to the neutral cyan "your move" style.
   */
  intent?: "buy" | "sell" | "neutral";
  /** Optional override for the "your move" message. */
  yourTurnLabel?: string;
};

/**
 * Prominent turn-status banner. Conveys state through role, an icon, color,
 * AND text — never color alone — and announces changes politely to assistive
 * tech via aria-live.
 */
export function TurnBanner({
  isYourTurn,
  waitingForName,
  intent = "neutral",
  yourTurnLabel = "Your move",
}: TurnBannerProps) {
  const modifier = isYourTurn
    ? intent === "buy"
      ? "turn-banner--buy"
      : intent === "sell"
        ? "turn-banner--sell"
        : ""
    : "turn-banner--waiting";

  const className = ["turn-banner", modifier].filter(Boolean).join(" ");

  const text = isYourTurn
    ? yourTurnLabel
    : waitingForName
      ? `Waiting for ${waitingForName}`
      : "Waiting";

  const icon = isYourTurn ? "▶" : "⏳";

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-your-turn={isYourTurn ? "true" : "false"}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{text}</span>
    </div>
  );
}
