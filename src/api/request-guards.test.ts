import {
  createBoundedRateLimiter,
  createRoomCreationRateLimiter,
  createRoomCustomAmazonRateLimiter,
  isAllowedOrigin,
} from "./request-guards";

function request(headers: HeadersInit = {}): Request {
  return new Request("https://trader-titan.test/api/generate-item", {
    headers,
    method: "POST",
  });
}

describe("request guards", () => {
  it("allows missing or same-origin requests and rejects cross-origin requests", () => {
    expect(isAllowedOrigin(request())).toBe(true);
    expect(isAllowedOrigin(request({ origin: "https://trader-titan.test" }))).toBe(true);
    expect(isAllowedOrigin(request({ origin: "https://trader-titan.test/ignored" }))).toBe(true);
    expect(isAllowedOrigin(request({ origin: "https://evil.test" }))).toBe(false);
    expect(isAllowedOrigin(request({ origin: "null" }))).toBe(false);
  });

  it("enforces per-key rate limits and resets after the window", () => {
    let nowMs = 1_000;
    const limiter = createBoundedRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      maxBuckets: 10,
      now: () => nowMs,
    });
    const firstIp = request({ "cf-connecting-ip": "203.0.113.1" });
    const secondIp = request({ "cf-connecting-ip": "203.0.113.2" });

    expect(limiter(firstIp)).toBe(true);
    expect(limiter(firstIp)).toBe(true);
    expect(limiter(firstIp)).toBe(false);
    expect(limiter(secondIp)).toBe(true);

    nowMs += 60_001;
    expect(limiter(firstIp)).toBe(true);
  });

  it("bounds the number of tracked request buckets", () => {
    const limiter = createBoundedRateLimiter({
      windowMs: 60_000,
      maxRequests: 20,
      maxBuckets: 2,
      now: () => 1_000,
    });

    expect(limiter(request({ "cf-connecting-ip": "203.0.113.1" }))).toBe(true);
    expect(limiter(request({ "cf-connecting-ip": "203.0.113.2" }))).toBe(true);
    expect(limiter(request({ "cf-connecting-ip": "203.0.113.3" }))).toBe(true);
    expect(limiter.bucketCount()).toBe(2);
  });

  it("does not trust caller-supplied x-forwarded-for for independent buckets", () => {
    const limiter = createBoundedRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxBuckets: 10,
      now: () => 1_000,
    });

    expect(limiter(request({ "x-forwarded-for": "203.0.113.1" }))).toBe(true);
    expect(limiter(request({ "x-forwarded-for": "203.0.113.2" }))).toBe(false);
    expect(limiter.bucketCount()).toBe(1);
  });

  it("creates bounded room route limiters from shared primitives", () => {
    const creationLimiter = createRoomCreationRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxBuckets: 2,
      now: () => 1_000,
    });
    const customAmazonLimiter = createRoomCustomAmazonRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxBuckets: 2,
      now: () => 1_000,
    });

    expect(creationLimiter(request({ "cf-connecting-ip": "203.0.113.1" }))).toBe(true);
    expect(creationLimiter(request({ "cf-connecting-ip": "203.0.113.1" }))).toBe(false);
    expect(customAmazonLimiter(request({ "cf-connecting-ip": "203.0.113.1" }))).toBe(true);
    expect(customAmazonLimiter(request({ "cf-connecting-ip": "203.0.113.1" }))).toBe(false);
  });
});
