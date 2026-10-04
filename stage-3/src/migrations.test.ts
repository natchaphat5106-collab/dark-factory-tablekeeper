/**
 * Unit 5 — migration runner.
 *
 * Claims: versioned and ascending; idempotent; atomic per migration; and sharing the one
 * `schema_migration` ledger stage 1 already uses rather than starting a second one.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDatabase, openDatabase, type Db } from '../../stage-1/src/db.ts';
import { currentVersion, runMigrations, type Migration } from './migrations.ts';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'stage3-migrations-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function memory(): Db {
  return new DatabaseSync(':memory:');
}

const createWidgets: Migration = {
  name: '0002_widgets',
  up: (db) => db.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY)'),
};
const createGadgets: Migration = {
  name: '0003_gadgets',
  up: (db) => db.exec('CREATE TABLE gadgets (id TEXT PRIMARY KEY)'),
};

function tableExists(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

describe('runMigrations / currentVersion', () => {
  it('applies unapplied migrations in ascending name order', () => {
    const db = memory();
    const applied = runMigrations(db, [createGadgets, createWidgets]);
    assert.deepEqual(applied, ['0002_widgets', '0003_gadgets']);
    assert.equal(currentVersion(db), '0003_gadgets');
    assert.equal(tableExists(db, 'widgets'), true);
    assert.equal(tableExists(db, 'gadgets'), true);
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const db = memory();
    runMigrations(db, [createWidgets]);
    assert.deepEqual(runMigrations(db, [createWidgets]), []);
    const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migration').get() as { n: number };
    assert.equal(row.n, 1);
    db.close();
  });

  it('skips names already present in the ledger', () => {
    const db = memory();
    db.exec('CREATE TABLE schema_migration (name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_migration (name, applied_at_utc) VALUES (?, ?)').run(
      '0002_widgets',
      new Date().toISOString(),
    );

    const applied = runMigrations(db, [
      { name: '0002_widgets', up: () => assert.fail('must not re-run an applied migration') },
      createGadgets,
    ]);
    assert.deepEqual(applied, ['0003_gadgets']);
    assert.equal(tableExists(db, 'widgets'), false);
    db.close();
  });

  it('rolls back a failing migration and records nothing', () => {
    const db = memory();
    const broken: Migration = {
      name: '0002_broken',
      up: (inner) => {
        inner.exec('CREATE TABLE half (id TEXT)');
        throw new Error('boom');
      },
    };
    assert.throws(() => runMigrations(db, [broken]), /boom/);
    assert.equal(tableExists(db, 'half'), false);
    assert.equal(currentVersion(db), null);

    runMigrations(db, [{ name: '0002_broken', up: (inner) => inner.exec('CREATE TABLE half (id TEXT)') }]);
    assert.equal(tableExists(db, 'half'), true);
    assert.equal(currentVersion(db), '0002_broken');
    db.close();
  });

  it('does not create the ledger when only read', () => {
    const db = memory();
    assert.equal(currentVersion(db), null);
    assert.equal(tableExists(db, 'schema_migration'), false);
    db.close();
  });

  it('rejects malformed migration lists', () => {
    const db = memory();
    assert.throws(() => runMigrations(db, [{ name: '', up: () => {} }]), TypeError);
    assert.throws(
      () => runMigrations(db, [{ name: 'x', up: () => {} }, { name: 'x', up: () => {} }]),
      /duplicate migration name/,
    );
    assert.throws(() => runMigrations(db, [{ name: 'x', up: undefined as never }]), TypeError);
    db.close();
  });
});

describe('one ledger, shared with stage 1', () => {
  it('extends the stage-1 ledger without creating a second', () => {
    const path = join(dir, 'shared.db');
    const db = openDatabase(path);
    try {
      assert.equal(currentVersion(db), '0001_booking_core');

      const applied = runMigrations(db, [createWidgets]);
      assert.deepEqual(applied, ['0002_widgets']);
      assert.equal(currentVersion(db), '0002_widgets');

      const ledgers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
        .all();
      assert.equal(ledgers.length, 1);

      const rows = db.prepare('SELECT name FROM schema_migration ORDER BY name').all() as { name: string }[];
      assert.deepEqual(
        rows.map((row) => row.name),
        ['0001_booking_core', '0002_widgets'],
      );
    } finally {
      closeDatabase(db);
    }
  });
});
