/**
 * Unit 2 — token-bucket rate limiting.
 *
 * Claims: a fresh bucket permits exactly `capacity` and then denies; tokens refill at the
 * configured rate; `retryAfterMs` is the exact wait for the next token; buckets are
 * isolated per key; reset works per key and globally; bad config is rejected.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkRateLimit, resetRateLimit } from './rate-limit.ts';

let clock = 0;
const now = (): number => clock;

beforeEach(() => {
  clock = 0;
  resetRateLimit();
});

describe('checkRateLimit', () => {
  it('permits exactly capacity requests, then denies', () => {
    const config = { capacity: 3, refillPerSecond: 1, now };
    const decisions = [0, 1, 2, 3].map(() => checkRateLimit('k', config));
    assert.deepEqual(
      decisions.map((d) => d.allowed),
      [true, true, true, false],
    );
    assert.deepEqual(
      decisions.map((d) => d.remaining),
      [2, 1, 0, 0],
    );
  });

  it('refills one token per second for the default rate', () => {
    const config = { capacity: 1, refillPerSecond: 1, now };
    assert.equal(checkRateLimit('k', config).allowed, true);
    assert.equal(checkRateLimit('k', config).allowed, false);

    clock += 999;
    assert.equal(checkRateLimit('k', config).allowed, false);

    clock += 1;
    assert.equal(checkRateLimit('k', config).allowed, true);
  });

  it('reports the exact wait for the next token', () => {
    const config = { capacity: 1, refillPerSecond: 2, now };
    checkRateLimit('k', config);

    clock += 100;
    const decision = checkRateLimit('k', config);
    assert.equal(decision.allowed, false);
    assert.equal(decision.retryAfterMs, 400);

    clock += 400;
    assert.equal(checkRateLimit('k', config).allowed, true);
  });

  it('never refills past capacity, however long it idles', () => {
    const config = { capacity: 2, refillPerSecond: 100, now };
    checkRateLimit('k', config);
    checkRateLimit('k', config);
    clock += 24 * 60 * 60 * 1000;

    assert.equal(checkRateLimit('k', config).remaining, 1);
    assert.equal(checkRateLimit('k', config).remaining, 0);
    assert.equal(checkRateLimit('k', config).allowed, false);
  });

  it('isolates buckets by key', () => {
    const config = { capacity: 1, refillPerSecond: 1, now };
    assert.equal(checkRateLimit('a', config).allowed, true);
    assert.equal(checkRateLimit('a', config).allowed, false);
    assert.equal(checkRateLimit('b', config).allowed, true);
  });
});

describe('resetRateLimit', () => {
  it('resets a single key', () => {
    const config = { capacity: 1, refillPerSecond: 1, now };
    checkRateLimit('a', config);
    checkRateLimit('b', config);
    resetRateLimit('a');

    assert.equal(checkRateLimit('a', config).allowed, true);
    assert.equal(checkRateLimit('b', config).allowed, false);
  });

  it('resets every key when called with no argument', () => {
    const config = { capacity: 1, refillPerSecond: 1, now };
    checkRateLimit('a', config);
    checkRateLimit('b', config);
    resetRateLimit();

    assert.equal(checkRateLimit('a', config).allowed, true);
    assert.equal(checkRateLimit('b', config).allowed, true);
  });
});

describe('input validation', () => {
  const bad = (config: unknown, key = 'k'): void => {
    assert.throws(() => checkRateLimit(key, config as never), TypeError);
  };

  it('rejects invalid capacity', () => {
    bad({ capacity: 0, refillPerSecond: 1 });
    bad({ capacity: -1, refillPerSecond: 1 });
    bad({ capacity: 1.5, refillPerSecond: 1 });
  });

  it('rejects invalid refill rates', () => {
    bad({ capacity: 1, refillPerSecond: 0 });
    bad({ capacity: 1, refillPerSecond: -1 });
    bad({ capacity: 1, refillPerSecond: Number.NaN });
    bad({ capacity: 1, refillPerSecond: Number.POSITIVE_INFINITY });
  });

  it('rejects an empty key', () => {
    bad({ capacity: 1, refillPerSecond: 1 }, '');
  });
});
