/**
 * Unit 4 — restart safety.
 *
 * A process that dies does not get to run cleanup. The durable facts it leaves behind are
 * whatever SQLite committed, so the only claim worth making is: reopen the same file and
 * the migration ledger and the schema are exactly where the last commit left them, and
 * re-running the migrator changes nothing.
 *
 * `ensureRestartSafe` is the startup check that asserts those facts. It is deliberately
 * testable without crashing a process: opening the file twice is the same operation a
 * restart performs.
 */

import { closeDatabase, openDatabase, type Db } from '../../stage-1/src/db.ts';

export const CORE_MIGRATION = '0001_booking_core';

/** The tables stage 1's core migration must have created, ledger included. */
export const REQUIRED_TABLES = [
  'schema_migration',
  'restaurant',
  'dining_table',
  'booking',
  'idempotency_key',
  'occupancy',
] as const;

export type RestartReport = {
  path: string;
  opens: number;
  coreVersion: string;
  migrations: string[];
  reopenStable: boolean;
  tables: string[];
};

function tableNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function ledgerNames(db: Db): string[] {
  if (!tableNames(db).includes('schema_migration')) return [];
  const rows = db.prepare('SELECT name FROM schema_migration ORDER BY name').all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * Open `path` twice, asserting the second open sees the same ledger and schema as the first.
 *
 * Throws when the ledger does not record the core migration, when a required table is
 * missing despite the ledger claiming it applied, or when a reopen is not a no-op. Each
 * throw is a startup refusal rather than a warning: serving on a schema the migrator does
 * not agree with is the failure this check exists to prevent.
 */
export function ensureRestartSafe(path: string): RestartReport {
  const snapshots: { names: string[]; tables: string[] }[] = [];

  for (let open = 1; open <= 2; open += 1) {
    const db = openDatabase(path);
    try {
      snapshots.push({ names: ledgerNames(db), tables: tableNames(db) });
    } finally {
      closeDatabase(db);
    }
  }

  const first = snapshots[0] as { names: string[]; tables: string[] };
  const second = snapshots[1] as { names: string[]; tables: string[] };

  if (!first.names.includes(CORE_MIGRATION)) {
    throw new Error(`restart unsafe: schema_migration does not record ${CORE_MIGRATION}`);
  }
  const missing = REQUIRED_TABLES.filter((table) => !first.tables.includes(table));
  if (missing.length > 0) {
    throw new Error(`restart unsafe: required tables missing: ${missing.join(', ')}`);
  }
  const duplicate = first.names.filter((name, index) => first.names.indexOf(name) !== index);
  if (duplicate.length > 0) {
    throw new Error(`restart unsafe: duplicate ledger entries: ${[...new Set(duplicate)].join(', ')}`);
  }
  const reopenStable =
    first.names.length === second.names.length &&
    first.names.every((name, index) => name === second.names[index]) &&
    first.tables.length === second.tables.length &&
    first.tables.every((name, index) => name === second.tables[index]);
  if (!reopenStable) {
    throw new Error('restart unsafe: reopening the database changed the ledger or schema');
  }

  return {
    path,
    opens: 2,
    coreVersion: CORE_MIGRATION,
    migrations: first.names,
    reopenStable,
    tables: first.tables,
  };
}
