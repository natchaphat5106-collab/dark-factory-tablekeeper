/**
 * Unit 4 — restart safety.
 *
 * The crash is real: a child process opens the database, commits a row, and exits with
 * `process.exit(0)` without closing. The parent then reopens the same file and asks
 * whether the ledger, the schema, and the committed row are all still there.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDatabase, openDatabase } from '../../stage-1/src/db.ts';
import { CORE_MIGRATION, REQUIRED_TABLES, ensureRestartSafe } from './restart.ts';

// Resolved from this file, not from process.cwd(), so the test passes from any directory.
const DB_TS = new URL('../../stage-1/src/db.ts', import.meta.url).href;

let dir: string;
const pathFor = (name: string): string => join(dir, name);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'stage3-restart-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureRestartSafe', () => {
  it('accepts a freshly migrated file and reports its ledger and tables', () => {
    const path = pathFor('fresh.db');
    const report = ensureRestartSafe(path);

    assert.equal(report.opens, 2);
    assert.equal(report.coreVersion, CORE_MIGRATION);
    assert.equal(report.reopenStable, true);
    assert.ok(report.migrations.includes(CORE_MIGRATION));
    for (const table of REQUIRED_TABLES) assert.ok(report.tables.includes(table), `missing ${table}`);
  });

  it('records the core migration exactly once after repeated opens', () => {
    const path = pathFor('idempotent.db');
    for (let i = 0; i < 3; i += 1) closeDatabase(openDatabase(path));

    const db = openDatabase(path);
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migration').get() as { n: number };
      assert.equal(row.n, 1);
    } finally {
      closeDatabase(db);
    }
  });

  it('survives a crash that never closed the database', () => {
    const path = pathFor('crash.db');

    // First establish the schema, then crash after committing a row.
    closeDatabase(openDatabase(path));
    const script = [
      `import { openDatabase } from ${JSON.stringify(DB_TS)};`,
      `const db = openDatabase(${JSON.stringify(path)});`,
      `db.prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)').run('crash-r', 'Crash', 'UTC');`,
      `process.exit(0);`,
    ].join('\n');
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });

    const db = openDatabase(path);
    try {
      const row = db.prepare('SELECT name FROM restaurant WHERE id = ?').get('crash-r') as
        | { name: string }
        | undefined;
      assert.equal(row?.name, 'Crash');
      const ledger = db.prepare('SELECT COUNT(*) AS n FROM schema_migration').get() as { n: number };
      assert.equal(ledger.n, 1);
    } finally {
      closeDatabase(db);
    }

    assert.equal(ensureRestartSafe(path).reopenStable, true);
  });

  it('refuses a schema the ledger claims but the file lacks', () => {
    const path = pathFor('broken.db');
    const db = openDatabase(path);
    db.exec('DROP TABLE occupancy');
    closeDatabase(db);

    assert.throws(() => ensureRestartSafe(path), /required tables missing: occupancy/);
  });
});
