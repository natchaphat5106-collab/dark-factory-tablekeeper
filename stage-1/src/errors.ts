/**
 * The error taxonomy and its HTTP mapping.
 *
 * Every non-2xx response in this service is one of these codes. A code is not a
 * free-form string: it carries a fixed status here, so a caller can branch on
 * `error.code` and a reviewer can enumerate the whole surface from one map.
 */

export const ERROR_STATUS = {
  INVALID_TIME: 400,
  AMBIGUOUS_LOCAL_TIME: 400,
  INVALID_TIMEZONE: 400,
  INVALID_PARTY_SIZE: 400,
  INVALID_DURATION: 400,
  INVALID_TABLE: 400,
  SLOT_TAKEN: 409,
  TABLE_TOO_SMALL: 409,
  KEY_REUSED: 409,
  NOT_FOUND: 404,
  BUSY_RETRY_EXHAUSTED: 503,
  /**
   * The catch-all. Present in the taxonomy rather than cast in at the throw site, so the
   * whole failure surface stays enumerable from one map and `ErrorCode` cannot disagree
   * with what a caller is actually sent.
   */
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorDetails = Record<string, unknown>;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toEnvelope(): { status: number; body: { error: { code: ErrorCode; message: string; details: ErrorDetails } } } {
    return {
      status: this.status,
      body: { error: { code: this.code, message: this.message, details: this.details } },
    };
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

// SQLite primary result codes meaning "another writer holds the lock". node:sqlite
// exposes these as the numeric `errcode`; its own `code` is always the generic
// 'ERR_SQLITE_ERROR', so matching on `code` would classify every constraint failure
// as contention.
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_BUSY_RECOVERY = 261;
const SQLITE_BUSY_SNAPSHOT = 517;
const SQLITE_BUSY_TIMEOUT = 773;
const BUSY_CODES: ReadonlySet<number> = new Set([
  SQLITE_BUSY,
  SQLITE_LOCKED,
  SQLITE_BUSY_RECOVERY,
  SQLITE_BUSY_SNAPSHOT,
  SQLITE_BUSY_TIMEOUT,
]);

/** True for the SQLite errors that mean "a writer held the lock; try again". */
export function isBusyError(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' && BUSY_CODES.has(errcode);
}

/**
 * True for a primary-key violation on `occupancy` — a genuine double-book attempt.
 *
 * Deliberately narrow: a CHECK or FOREIGN KEY failure on the same table is a
 * different defect and must not be reported to a caller as "the slot is taken".
 */
export function isOccupancyKeyViolation(err: unknown): boolean {
  const message = (err as { message?: unknown } | null)?.message;
  return (
    typeof message === 'string' &&
    message.startsWith('UNIQUE constraint failed: occupancy.dining_table_id, occupancy.quantum_start_utc')
  );
}

/**
 * Turn anything thrown into the single response shape. An unrecognised throw is
 * reported as `NOT_FOUND` only when it really is a lookup miss; anything else is a
 * 500 with a generic message, because leaking an internal message to a caller is
 * worse than being vague.
 */
export function toErrorResponse(err: unknown): {
  status: number;
  body: { error: { code: ErrorCode; message: string; details: ErrorDetails } };
} {
  // Every branch returns an ApiError envelope, so the code here is a real member of
  // ErrorCode and the taxonomy test in test/http.test.ts can require it to be reachable.
  if (isApiError(err)) return err.toEnvelope();
  if (isBusyError(err)) {
    return new ApiError(
      'BUSY_RETRY_EXHAUSTED',
      'the booking store is busy; the request may be retried',
      { retryable: true },
    ).toEnvelope();
  }
  return new ApiError('INTERNAL', 'the request could not be completed').toEnvelope();
}