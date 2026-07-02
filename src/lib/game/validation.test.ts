import {
  parseNumericInput,
  quoteFromAsk,
  quoteFromBid,
  validateQuote,
  validateQuoteForWidth,
  validateSpreadWidth,
  validateTightenedWidth,
} from "./validation";
import { MAX_PLAYABLE_ABSOLUTE_VALUE } from "./types";

describe("quote validation", () => {
  it("rejects equality and inversion", () => {
    expect(validateQuote({ bid: 10, ask: 10 })).toEqual({
      ok: false,
      error: "Quote bid must be less than ask.",
    });
    expect(validateQuote({ bid: 11, ask: 10 })).toEqual({
      ok: false,
      error: "Quote bid must be less than ask.",
    });
  });

  it("rejects NaN and Infinity", () => {
    expect(validateQuote({ bid: Number.NaN, ask: 10 })).toEqual({
      ok: false,
      error: "Quote bid and ask must be finite numbers.",
    });
    expect(validateQuote({ bid: 1, ask: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      error: "Quote bid and ask must be finite numbers.",
    });
  });

  it("keeps empty parsed inputs out of quote validation", () => {
    const bid = parseNumericInput("");
    const ask = parseNumericInput("   ");

    expect(bid).toBeNull();
    expect(ask).toBeNull();
  });

  it("requires the final quote to match the accepted spread width", () => {
    expect(validateQuoteForWidth({ bid: 200, ask: 400 }, 200)).toEqual({
      ok: true,
    });
    expect(validateQuoteForWidth({ bid: 200, ask: 401 }, 200)).toEqual({
      ok: false,
      error: "Bid and ask must match the accepted spread width.",
    });
  });

  it("accepts fractional widths on large quotes produced from bid plus width", () => {
    const quote = quoteFromBid(100_000_000.5, 0.1);

    expect(validateQuoteForWidth(quote, 0.1)).toEqual({ ok: true });
  });

  it("scales spread tolerance for Cosmic Scale magnitudes", () => {
    const quote = quoteFromBid(MAX_PLAYABLE_ABSOLUTE_VALUE - 1, 0.1);

    expect(validateQuoteForWidth(quote, 0.1)).toEqual({ ok: true });
  });

  it("rejects meaningful spread mismatches at large magnitudes", () => {
    const bid = MAX_PLAYABLE_ABSOLUTE_VALUE - 1;

    expect(validateQuoteForWidth({ bid, ask: bid + 0.2 }, 0.1)).toEqual({
      ok: false,
      error: "Bid and ask must match the accepted spread width.",
    });
  });

  it("keeps quote value maximum checks before spread width tolerance", () => {
    expect(
      validateQuoteForWidth(
        {
          bid: MAX_PLAYABLE_ABSOLUTE_VALUE - 0.5,
          ask: MAX_PLAYABLE_ABSOLUTE_VALUE + 0.5,
        },
        1,
      ),
    ).toEqual({
      ok: false,
      error: `Quote values must be within +/-${MAX_PLAYABLE_ABSOLUTE_VALUE}.`,
    });
  });

  it("derives the opposite side of the market from the fixed width", () => {
    expect(quoteFromAsk(400, 200)).toEqual({ bid: 200, ask: 400 });
    expect(quoteFromBid(200, 200)).toEqual({ bid: 200, ask: 400 });
  });
});

describe("spread width validation", () => {
  it("rejects non-finite and non-positive widths", () => {
    expect(validateSpreadWidth(Number.NaN)).toEqual({
      ok: false,
      error: "Spread width must be a finite number.",
    });
    expect(validateSpreadWidth(0)).toEqual({
      ok: false,
      error: "Spread width must be greater than 0.",
    });
  });

  it("accepts positive finite widths", () => {
    expect(validateSpreadWidth(500)).toEqual({ ok: true });
  });

  it("requires each later proposal to be tighter than the current width", () => {
    expect(validateTightenedWidth(500, 200)).toEqual({ ok: true });
    expect(validateTightenedWidth(500, 500)).toEqual({
      ok: false,
      error: "New spread width must be tighter than current width.",
    });
    expect(validateTightenedWidth(500, 700)).toEqual({
      ok: false,
      error: "New spread width must be tighter than current width.",
    });
  });
});
