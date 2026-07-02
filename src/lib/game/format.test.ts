import { formatSignedNumber } from "./format";

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
