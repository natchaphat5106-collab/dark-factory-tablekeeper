/**
 * Unit 1 — API-key authentication.
 *
 * The claims under test, in the order the unit states them:
 *   - `validateApiKey` accepts exactly the configured keys and nothing else;
 *   - `requireApiKey` reads a Bearer token or the direct key header and returns the key;
 *   - a missing or invalid key throws an `AuthError` whose envelope is a 401 and whose
 *     shape is identical to stage 1's `ApiError` envelope — not merely similar.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, toErrorResponse } from '../../stage-1/src/errors.ts';
import {
  AuthError,
  isAuthError,
  requireApiKey,
  validateApiKey,
  UNAUTHORIZED_STATUS,
} from './auth.ts';

const KEYS = ['key-alpha-0000000000000000000000000000000000000000000000000000000000', 'key-beta'];

describe('validateApiKey', () => {
  it('accepts an exact key and rejects a different one', () => {
    assert.equal(validateApiKey(KEYS[0], KEYS), true);
    assert.equal(validateApiKey('key-gamma', KEYS), false);
  });

  it('accepts a member of a multi-key list', () => {
    assert.equal(validateApiKey('key-beta', KEYS), true);
  });

  it('rejects non-strings, empty strings, and an empty key list', () => {
    assert.equal(validateApiKey(undefined, KEYS), false);
    assert.equal(validateApiKey(null, KEYS), false);
    assert.equal(validateApiKey(42, KEYS), false);
    assert.equal(validateApiKey('', KEYS), false);
    assert.equal(validateApiKey(KEYS[0], []), false);
  });

  it('does not throw on a length mismatch (constant-time compare tolerates it)', () => {
    assert.equal(validateApiKey('x', KEYS), false);
    assert.equal(validateApiKey(KEYS[0] + 'extra', KEYS), false);
  });

  it('treats a key as opaque: no trimming, no case folding', () => {
    assert.equal(validateApiKey(` ${KEYS[0]} `, KEYS), false);
    assert.equal(validateApiKey(KEYS[0]!.toUpperCase(), KEYS), false);
  });
});

describe('requireApiKey', () => {
  it('returns the key from a Bearer authorization header', () => {
    const key = requireApiKey({ authorization: `Bearer ${KEYS[0]}` }, { keys: KEYS });
    assert.equal(key, KEYS[0]);
  });

  it('accepts the Bearer scheme case-insensitively', () => {
    const key = requireApiKey({ authorization: `bearer ${KEYS[1]}` }, { keys: KEYS });
    assert.equal(key, KEYS[1]);
  });

  it('returns the key from the direct x-api-key header', () => {
    const key = requireApiKey({ 'x-api-key': KEYS[1] }, { keys: KEYS });
    assert.equal(key, KEYS[1]);
  });

  it('finds headers regardless of the case the caller used', () => {
    const key = requireApiKey({ Authorization: `Bearer ${KEYS[1]}`, 'X-API-Key': 'ignored' }, { keys: KEYS });
    assert.equal(key, KEYS[1]);
  });

  it('uses the first value when a header arrives as an array', () => {
    const key = requireApiKey({ authorization: [`Bearer ${KEYS[0]}`, 'Bearer old'] }, { keys: KEYS });
    assert.equal(key, KEYS[0]);
  });

  it('falls back to the direct header when authorization is not a Bearer token', () => {
    const key = requireApiKey({ authorization: 'Basic Zm9v', 'x-api-key': KEYS[0] }, { keys: KEYS });
    assert.equal(key, KEYS[0]);
  });

  it('rejects a missing key with reason "missing"', () => {
    assert.throws(
      () => requireApiKey({}, { keys: KEYS }),
      (err: unknown) => {
        assert.equal(isAuthError(err), true);
        assert.ok(err instanceof AuthError);
        assert.equal(err.details.reason, 'missing');
        return true;
      },
    );
  });

  it('rejects an invalid key with reason "invalid"', () => {
    assert.throws(
      () => requireApiKey({ authorization: 'Bearer not-a-key' }, { keys: KEYS }),
      (err: unknown) => {
        assert.equal(isAuthError(err), true);
        assert.ok(err instanceof AuthError);
        assert.equal(err.details.reason, 'invalid');
        return true;
      },
    );
  });

  it('refuses every request when the key list is empty', () => {
    assert.throws(
      () => requireApiKey({ authorization: `Bearer ${KEYS[0]}` }, { keys: [] }),
      (err: unknown) => err instanceof AuthError && err.details.reason === 'invalid',
    );
  });

  it('does not echo the presented key into details or the message', () => {
    const presented = 'super-secret-presented-value';
    try {
      requireApiKey({ authorization: `Bearer ${presented}` }, { keys: KEYS });
      assert.fail('expected a rejection');
    } catch (err) {
      assert.ok(err instanceof AuthError);
      const serialised = JSON.stringify(err.toEnvelope()) + String(err.message);
      assert.equal(serialised.includes(presented), false);
    }
  });
});

describe('requireApiKey 401 envelope', () => {
  function capture(): AuthError {
    try {
      requireApiKey({}, { keys: KEYS });
      assert.fail('expected a rejection');
    } catch (err) {
      assert.ok(err instanceof AuthError);
      return err;
    }
  }

  it('is a 401 with code UNAUTHORIZED', () => {
    const envelope = capture().toEnvelope();
    assert.equal(envelope.status, UNAUTHORIZED_STATUS);
    assert.equal(envelope.status, 401);
    assert.equal(envelope.body.error.code, 'UNAUTHORIZED');
  });

  it('has the same top-level and error-level shape as stage 1\'s envelope', () => {
    const ours = capture().toEnvelope();
    const stage1 = toErrorResponse(new ApiError('NOT_FOUND', 'no such restaurant'));
    assert.deepEqual(Object.keys(ours).sort(), Object.keys(stage1).sort());
    assert.deepEqual(Object.keys(ours.body).sort(), Object.keys(stage1.body).sort());
    assert.deepEqual(Object.keys(ours.body.error).sort(), Object.keys(stage1.body.error).sort());
    assert.equal(typeof ours.body.error.message, 'string');
    assert.equal(typeof ours.body.error.details, 'object');
  });
});
