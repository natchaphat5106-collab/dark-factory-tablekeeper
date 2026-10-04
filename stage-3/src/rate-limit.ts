/**
 * Unit 2 — per-key token-bucket rate limiting.
 *
 * One bucket per key. A bucket starts full; every allowed check costs one token; tokens
 * refill at `refillPerSecond` up to `capacity`. Fractional tokens are kept, so a slow
 * refill still admits a request the moment a whole token exists rather than rounding up
 * to a burst.
 *
 * The clock is injectable so a test measures refill and retry hints against a clock it
 * controls, not against wall time.
 */

export type RateLimitConfig = {
  /** Maximum tokens, i.e. the burst a fresh key may spend at once. Integer >= 1. */
  capacity: number;
  /** Tokens added per second. Finite and > 0. */
  refillPerSecond: number;
  /** Monotonic millisecond clock. Defaults to `Date.now`. */
  now?: () => number;
};

export type RateLimitDecision = {
  allowed: boolean;
  /** Whole tokens left after this check. */
  remaining: number;
  /** Milliseconds until one token exists again. 0 while allowed. */
  retryAfterMs: number;
};

type Bucket = {
  tokens: number;
  updatedAtMs: number;
};

const buckets = new Map<string, Bucket>();

function assertConfig(config: RateLimitConfig): void {
  if (!Number.isInteger(config.capacity) || config.capacity < 1) {
    throw new TypeError(`capacity must be an integer >= 1, got ${String(config.capacity)}`);
  }
  if (
    typeof config.refillPerSecond !== 'number' ||
    !Number.isFinite(config.refillPerSecond) ||
    config.refillPerSecond <= 0
  ) {
    throw new TypeError(`refillPerSecond must be a finite number > 0, got ${String(config.refillPerSecond)}`);
  }
}

/**
 * Spend one token for `key`, refilling first.
 *
 * `retryAfterMs` is the exact wait for the next whole token, so a caller can put it in a
 * `Retry-After` header rather than guess.
 */
export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitDecision {
  assertConfig(config);
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('key must be a non-empty string');
  }
  const now = (config.now ?? Date.now)();
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError(`now() must return a finite number, got ${String(now)}`);
  }

  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = { tokens: config.capacity, updatedAtMs: now };
    buckets.set(key, bucket);
  }

  const elapsedMs = Math.max(0, now - bucket.updatedAtMs);
  if (elapsedMs > 0) {
    const refill = (elapsedMs / 1000) * config.refillPerSecond;
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refill);
    bucket.updatedAtMs = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  const deficit = 1 - bucket.tokens;
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: Math.ceil((deficit / config.refillPerSecond) * 1000),
  };
}

/** Drop one key's bucket, or every bucket when called with no key. */
export function resetRateLimit(key?: string): void {
  if (key === undefined) {
    buckets.clear();
    return;
  }
  buckets.delete(key);
}
