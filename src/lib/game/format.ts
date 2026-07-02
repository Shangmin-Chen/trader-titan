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
