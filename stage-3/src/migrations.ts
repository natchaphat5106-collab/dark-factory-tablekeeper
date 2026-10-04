/**
 * Unit 5 — a versioned migration runner over stage 1's ledger.
 *
 * There is exactly one ledger: `schema_migration`, the table stage 1's `migrate()` already
 * writes `0001_booking_core` into. This runner reads and writes that same table, so a
 * database upgraded by stage 1 and one upgraded here cannot disagree about what ran.
 *
 * Each migration runs inside its own `BEGIN IMMEDIATE … COMMIT` together with its ledger
 * row, so a migration that throws leaves neither its DDL nor its ledger entry behind, and
 * a rerun starts from exactly the last committed version.
 *
 * Names are applied in ascending lexicographic order. Callers zero-pad them
 * (`0002_rate_limits`) so string order is version order.
 */

import { type Db } from '../../stage-1/src/db.ts';

export type Migration = {
  name: string;
  up: (db: Db) => void;
};

const LEDGER = 'schema_migration';

function ledgerExists(db: Db): boolean {
  return (
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(LEDGER) !==
    undefined
  );
}

function ensureLedger(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       name           TEXT PRIMARY KEY,
       applied_at_utc TEXT NOT NULL
     )`,
  );
}

/**
 * Read-only: an absent ledger means nothing has run, so it is reported as empty rather
 * than created. Creation belongs to `runMigrations`, so that the ledger's existence
 * stays evidence that a write path ran.
 */
function appliedNames(db: Db): Set<string> {
  if (!ledgerExists(db)) return new Set<string>();
  const rows = db.prepare(`SELECT name FROM ${LEDGER}`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function assertMigrations(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (typeof migration.name !== 'string' || migration.name.length === 0) {
      throw new TypeError('migration name must be a non-empty string');
    }
    if (seen.has(migration.name)) {
      throw new TypeError(`duplicate migration name: ${migration.name}`);
    }
    if (typeof migration.up !== 'function') {
      throw new TypeError(`migration ${migration.name} has no up() function`);
    }
    seen.add(migration.name);
  }
}

/** The greatest applied name by lexicographic order, or `null` when nothing has run. */
export function currentVersion(db: Db): string | null {
  const names = [...appliedNames(db)].sort();
  return names.length === 0 ? null : (names[names.length - 1] as string);
}

/**
 * Apply every migration not yet in the ledger, ascending by name. Returns the names
 * applied in this call; a second call on the same database returns `[]`.
 */
export function runMigrations(db: Db, migrations: readonly Migration[]): string[] {
  assertMigrations(migrations);
  const done = appliedNames(db);
  const ordered = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const appliedNow: string[] = [];

  if (ordered.some((migration) => !done.has(migration.name))) ensureLedger(db);

  for (const migration of ordered) {
    if (done.has(migration.name)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare(`INSERT INTO ${LEDGER} (name, applied_at_utc) VALUES (?, ?)`).run(
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // No transaction is active: SQLite already unwound it.
      }
      throw err;
    }
    done.add(migration.name);
    appliedNow.push(migration.name);
  }

  return appliedNow;
}
