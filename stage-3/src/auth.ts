/**
 * API-key authentication for stage 3.
 *
 * The response envelope is stage 1's, reused rather than copied into a new vocabulary:
 * `{ status, body: { error: { code, message, details } } }`, the same shape `ApiError`
 * emits from `stage-1/src/errors.ts`. Stage 1's taxonomy has no 401 code and is frozen, so
 * the code `UNAUTHORIZED` lives here and maps to 401 here. The envelope shape is shared;
 * the frozen file is not edited.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export type AuthCode = 'UNAUTHORIZED';

export const UNAUTHORIZED_CODE: AuthCode = 'UNAUTHORIZED';
export const UNAUTHORIZED_STATUS = 401;

export type AuthErrorDetails = Record<string, unknown>;

export type AuthEnvelope = {
  status: number;
  body: { error: { code: AuthCode; message: string; details: AuthErrorDetails } };
};

export class AuthError extends Error {
  readonly code: AuthCode = UNAUTHORIZED_CODE;
  readonly details: AuthErrorDetails;

  constructor(message: string, details: AuthErrorDetails = {}) {
    super(message);
    this.name = 'AuthError';
    this.details = details;
  }

  get status(): number {
    return UNAUTHORIZED_STATUS;
  }

  toEnvelope(): AuthEnvelope {
    return {
      status: this.status,
      body: { error: { code: this.code, message: this.message, details: this.details } },
    };
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}

/**
 * Compare two keys without leaking their length or the position of the first difference.
 *
 * Hashing both sides to a fixed-width digest keeps `timingSafeEqual` from ever seeing
 * unequal-length buffers (it throws on those) and keeps it from returning early. The scan
 * in `validateApiKey` still visits every configured key, so a caller cannot learn which
 * key matched — or how many bytes matched — by timing the response.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a, 'utf8').digest();
  const bh = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ah, bh);
}

/**
 * True only for a non-empty string equal to one of `keys`.
 *
 * No trimming and no case folding: an API key is an opaque secret, so `" key "` is not
 * `"key"`. An empty `keys` list is not "auth disabled"; it refuses everything.
 */
export function validateApiKey(candidate: unknown, keys: readonly string[]): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (!Array.isArray(keys) || keys.length === 0) return false;
  let matched = false;
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (constantTimeEqual(candidate, key)) matched = true;
  }
  return matched;
}

export type HeaderValue = string | string[] | undefined;
export type HeaderMap = Record<string, HeaderValue>;

export type RequireApiKeyConfig = {
  /** Accepted keys. An empty list refuses every request. */
  keys: readonly string[];
  /** Header carrying `Bearer <key>`. Defaults to `authorization`. */
  authorizationHeader?: string;
  /** Direct key header, read when the authorization header is absent or not a Bearer. Defaults to `x-api-key`. */
  apiKeyHeader?: string;
};

const BEARER = /^Bearer[ \t]+(.+)$/i;

/** Header lookup is case-insensitive because Node lowercases on the wire but callers do not. */
function readHeader(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function extractCandidate(headers: HeaderMap, config: RequireApiKeyConfig): string | undefined {
  const authorizationHeader = config.authorizationHeader ?? 'authorization';
  const apiKeyHeader = config.apiKeyHeader ?? 'x-api-key';

  const authorization = readHeader(headers, authorizationHeader);
  if (authorization !== undefined) {
    const match = BEARER.exec(authorization.trim());
    if (match !== null) {
      const token = match[1]?.trim() ?? '';
      if (token.length > 0) return token;
    }
  }

  const direct = readHeader(headers, apiKeyHeader);
  if (direct !== undefined) {
    const token = direct.trim();
    if (token.length > 0) return token;
  }

  return undefined;
}

/**
 * Return the validated key, or throw an `AuthError` that serialises to a 401.
 *
 * A missing key and a wrong key share status and message; `details.reason` separates them
 * for logs without telling the caller which guess was nearer. The presented key is never
 * echoed into `details` or into the error message.
 */
export function requireApiKey(headers: HeaderMap, config: RequireApiKeyConfig): string {
  const candidate = extractCandidate(headers, config);
  if (candidate === undefined) {
    throw new AuthError('an API key is required', { reason: 'missing' });
  }
  if (!validateApiKey(candidate, config.keys)) {
    throw new AuthError('the API key is not valid', { reason: 'invalid' });
  }
  return candidate;
}
