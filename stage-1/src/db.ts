/**
 * Connection, pragmas, migration, and the write transaction every mutating path
 * goes through.
 *
 * Two rules live here and nowhere else:
 *   - every connection is WAL with a busy timeout, so separate OS processes can
 *     write the same file concurrently without either one inventing a failure;
 *   - every write runs inside BEGIN IMMEDIATE, so the read-then-write sequence in
 *     bookings.ts is serialised by the database rather than by anything in this
 *     process.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isBusyError } from './errors.ts';

export type Db = DatabaseSync;

const SCHEMA_FILE = fileURLToPath(new URL('./schema.sql', import.meta.url));
const MIGRATION_NAME = '0001_booking_core';

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_BUSY_ATTEMPTS = 3;
const DEFAULT_BUSY_BACKOFF_MS = 20;

export type OpenOptions = {
  /** Overrides the 5000 ms default. Only the busy-path test needs a shorter wait. */
  busyTimeoutMs?: number;
};

export type TxOptions = {
  /** Attempts on SQLITE_BUSY before the caller is told to retry. */
  busyAttempts?: number;
  busyBackoffMs?: number;
};

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(`busyTimeoutMs must be a non-negative integer, got ${String(busyTimeoutMs)}`);
  }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // Switching journal_mode to WAL takes a brief exclusive lock, and busy_timeout does
  // NOT make that wait: when several processes open the same fresh file at once the
  // losers get a plain SQLITE_BUSY out of a connection that has done nothing wrong. Retry
  // the switch itself, then the migration, so a cold start is safe for every opener.
  retryWhileBusy(() => db.exec('PRAGMA journal_mode = WAL'));
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Run `fn`, retrying the bounded number of times while SQLite reports ordinary contention. */
function retryWhileBusy(fn: () => void): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fn();
      return;
    } catch (err) {
      if (!isBusyError(err) || attempt >= DEFAULT_BUSY_ATTEMPTS) throw err;
      sleepSync(DEFAULT_BUSY_BACKOFF_MS * attempt);
    }
  }
}

export function closeDatabase(db: Db): void {
  db.close();
}

function migrationApplied(db: Db, name: string): boolean {
  const ledger = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
    .get();
  if (ledger === undefined) return false;
  return db.prepare('SELECT 1 AS present FROM schema_migration WHERE name = ?').get(name) !== undefined;
}

/**
 * Apply schema.sql once. Safe to call on every connection and safe to call twice:
 * the ledger is consulted inside an IMMEDIATE transaction, so a second migrator
 * that raced the first either sees the row or waits for it.
 *
 * `BEGIN IMMEDIATE` here already waits under the connection's busy_timeout, so no
 * explicit retry is needed: the loser of a migration race blocks until the winner
 * commits and then sees the ledger row. (The lock that does NOT wait is the
 * journal_mode switch in `openDatabase`, which retries explicitly.)
 */
export function migrate(db: Db): void {
  if (migrationApplied(db, MIGRATION_NAME)) return;
  const sql = readFileSync(SCHEMA_FILE, 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!migrationApplied(db, MIGRATION_NAME)) {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (name, applied_at_utc) VALUES (?, ?)').run(
        MIGRATION_NAME,
        new Date().toISOString(),
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

function rollbackQuietly(db: Db): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // No transaction is active: SQLite already unwound it. Nothing to undo.
  }
}

/** Block the thread. The only synchronous sleep available without a dependency. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How many times THIS process re-entered a write because SQLite reported contention.
 *
 * Both the BEGIN and the commit/body catch sites below increment it; the count is a
 * per-process fact, so a test can ask each separate OS process whether it actually collided
 * with another writer, rather than inferring overlap from how closely two clocks agree.
 * It is a diagnostic counter only — correctness never reads it.
 */
let busyRetries = 0;

export function busyRetryCount(): number {
  return busyRetries;
}

/**
 * Run `fn` inside BEGIN IMMEDIATE … COMMIT, rolling back on every error path.
 *
 * SQLITE_BUSY is retried a bounded number of times; exhausting the budget throws
 * the original busy error so the caller reports a retryable condition instead of
 * a success nobody earned. Correctness never depends on the retry — the occupancy
 * primary key holds whether or not this loop ever runs.
 */
export function inImmediateTransaction<T>(db: Db, fn: () => T, options: TxOptions = {}): T {
  const attempts = options.busyAttempts ?? DEFAULT_BUSY_ATTEMPTS;
  const backoffMs = options.busyBackoffMs ?? DEFAULT_BUSY_BACKOFF_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (!isBusyError(err) || attempt >= attempts) throw err;
      busyRetries += 1;
      sleepSync(backoffMs * attempt);
      continue;
    }
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      rollbackQuietly(db);
      if (isBusyError(err) && attempt < attempts) {
        busyRetries += 1;
        sleepSync(backoffMs * attempt);
        continue;
      }
      throw err;
    }
  }
}