export type RequestPredicate = (request: Request) => boolean;

export type BoundedRateLimiterOptions = Readonly<{
  windowMs: number;
  maxRequests: number;
  maxBuckets: number;
  now?: () => number;
}>;

export type BoundedRateLimiter = RequestPredicate &
  Readonly<{
    bucketCount: () => number;
    clear: () => void;
  }>;

export const ITEM_GENERATION_RATE_LIMIT_WINDOW_MS = 60_000;
export const ITEM_GENERATION_RATE_LIMIT_MAX_REQUESTS = 20;
export const ITEM_GENERATION_RATE_LIMIT_MAX_BUCKETS = 500;

export function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

export async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function createItemGenerationRateLimiter(
  options: Partial<BoundedRateLimiterOptions> = {},
): BoundedRateLimiter {
  return createBoundedRateLimiter({
    windowMs: ITEM_GENERATION_RATE_LIMIT_WINDOW_MS,
    maxRequests: ITEM_GENERATION_RATE_LIMIT_MAX_REQUESTS,
    maxBuckets: ITEM_GENERATION_RATE_LIMIT_MAX_BUCKETS,
    ...options,
  });
}

export function createBoundedRateLimiter({
  windowMs,
  maxRequests,
  maxBuckets,
  now = Date.now,
}: BoundedRateLimiterOptions): BoundedRateLimiter {
  const buckets = new Map<string, number[]>();

  const consume: BoundedRateLimiter = Object.assign(
    (request: Request): boolean => {
      const currentTime = now();
      pruneExpiredBuckets(buckets, currentTime, windowMs);

      const key = rateLimitKeyForRequest(request);
      const bucket = buckets.get(key) ?? [];

      if (bucket.length >= maxRequests) {
        buckets.set(key, bucket);
        return false;
      }

      if (!buckets.has(key) && buckets.size >= maxBuckets) {
        evictOldestBucket(buckets);
      }

      buckets.set(key, [...bucket, currentTime]);
      return true;
    },
    {
      bucketCount: () => buckets.size,
      clear: () => buckets.clear(),
    },
  );

  return consume;
}

function rateLimitKeyForRequest(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "anonymous";
}

function pruneExpiredBuckets(
  buckets: Map<string, number[]>,
  nowMs: number,
  windowMs: number,
): void {
  for (const [key, timestamps] of buckets) {
    const activeTimestamps = timestamps.filter((timestamp) => nowMs - timestamp < windowMs);

    if (activeTimestamps.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, activeTimestamps);
    }
  }
}

function evictOldestBucket(buckets: Map<string, number[]>): void {
  const oldestKey = buckets.keys().next().value;

  if (oldestKey !== undefined) {
    buckets.delete(oldestKey);
  }
}
