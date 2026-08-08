import type { Quote, TradeSide } from "./types";

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const preciseNumberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 6,
});

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatPreciseNumber(value: number): string {
  return preciseNumberFormatter.format(value);
}

export function formatSignedNumber(value: number): string {
  const formattedMagnitude = formatNumber(Math.abs(value));

  if (formattedMagnitude === "0") {
    return "0";
  }

  return `${value > 0 ? "+" : "-"}${formattedMagnitude}`;
}

export function formatQuote(quote: Quote): string {
  return `${formatNumber(quote.bid)} / ${formatNumber(quote.ask)}`;
}

export function formatTradeSide(side: TradeSide): string {
  return side === "BUY" ? "Buy" : "Sell";
}

/**
 * Human-readable label for a GamePhase. Shared by the always-visible status
 * chip (src/app/page.tsx) and RoundForfeitPanel's "Timed out during" row so
 * the two cannot drift apart - RoundForfeitPanel previously rendered the
 * bare enum string (e.g. "configuringMarket") straight into the UI instead
 * of going through this. The default case only matters for single-word
 * phases not called out below (currently "setup", "settling", "settlement",
 * "error"); every multi-word phase must have its own case.
 */
export function formatGamePhase(phase: string): string {
  switch (phase) {
    case "generatingItem":
      return "Generating";
    case "proposingWidth":
      return "Proposing width";
    case "negotiatingWidth":
      return "Negotiating width";
    case "configuringMarket":
      return "Setting market";
    case "choosingSide":
      return "Choosing side";
    case "roundForfeited":
      return "Round forfeited";
    case "gameOver":
      return "Game over";
    default:
      return phase.charAt(0).toUpperCase() + phase.slice(1);
  }
}
