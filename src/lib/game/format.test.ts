import { formatGamePhase, formatSignedNumber } from "./format";

describe("formatSignedNumber", () => {
  it("normalizes signed zero values to plain zero", () => {
    expect(formatSignedNumber(0)).toBe("0");
    expect(formatSignedNumber(-0)).toBe("0");
  });

  it("normalizes values that display as zero to plain zero", () => {
    expect(formatSignedNumber(0.004)).toBe("0");
    expect(formatSignedNumber(-0.004)).toBe("0");
  });

  it("preserves signs for displayed nonzero values", () => {
    expect(formatSignedNumber(0.01)).toBe("+0.01");
    expect(formatSignedNumber(-0.01)).toBe("-0.01");
  });
});

describe("formatGamePhase", () => {
  it("labels every multi-word phase with its own explicit case", () => {
    expect(formatGamePhase("generatingItem")).toBe("Generating");
    expect(formatGamePhase("proposingWidth")).toBe("Proposing width");
    expect(formatGamePhase("negotiatingWidth")).toBe("Negotiating width");
    expect(formatGamePhase("configuringMarket")).toBe("Setting market");
    expect(formatGamePhase("choosingSide")).toBe("Choosing side");
    expect(formatGamePhase("roundForfeited")).toBe("Round forfeited");
    expect(formatGamePhase("gameOver")).toBe("Game over");
  });

  it("falls back to capitalizing single-word phases not given an explicit case", () => {
    expect(formatGamePhase("setup")).toBe("Setup");
    expect(formatGamePhase("settling")).toBe("Settling");
    expect(formatGamePhase("settlement")).toBe("Settlement");
    expect(formatGamePhase("error")).toBe("Error");
  });
});
