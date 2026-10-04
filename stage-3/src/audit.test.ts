import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../stage-1/src/db.ts';
import { migrateAudit, writeAudit, readAudit, readAllAudit } from './audit.ts';

describe('audit trail', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tk3-audit-'));
    db = openDatabase(join(dir, 'test.db'));
    migrateAudit(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a create entry', () => {
    writeAudit(db, {
      actor: 'user-1',
      action: 'create',
      bookingId: 'b-1',
      restaurantId: 'r-1',
    });
    const entries = readAudit(db, 'b-1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'create');
    assert.equal(entries[0].actor, 'user-1');
  });

  it('records multiple entries in order', () => {
    writeAudit(db, { actor: 'u1', action: 'create', bookingId: 'b-1', restaurantId: 'r-1' });
    writeAudit(db, { actor: 'u1', action: 'cancel', bookingId: 'b-1', restaurantId: 'r-1' });
    writeAudit(db, { actor: 'u1', action: 'reschedule', bookingId: 'b-1', restaurantId: 'r-1' });
    const entries = readAudit(db, 'b-1');
    assert.equal(entries.length, 3);
    assert.equal(entries[0].action, 'create');
    assert.equal(entries[1].action, 'cancel');
    assert.equal(entries[2].action, 'reschedule');
  });

  it('returns empty for unknown booking', () => {
    const entries = readAudit(db, 'unknown');
    assert.equal(entries.length, 0);
  });

  it('rejects invalid action at store level', () => {
    assert.throws(() => {
      db.prepare(
        `INSERT INTO audit_log (ts_utc, actor, action, booking_id, restaurant_id, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(new Date().toISOString(), 'u1', 'invalid', 'b-1', 'r-1', '');
    });
  });

  it('readAllAudit returns latest first', () => {
    writeAudit(db, { actor: 'u1', action: 'create', bookingId: 'b-1', restaurantId: 'r-1' });
    writeAudit(db, { actor: 'u1', action: 'create', bookingId: 'b-2', restaurantId: 'r-1' });
    writeAudit(db, { actor: 'u1', action: 'create', bookingId: 'b-3', restaurantId: 'r-1' });
    const entries = readAllAudit(db, 10);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].booking_id, 'b-3');
  });

  it('records details when provided', () => {
    writeAudit(db, {
      actor: 'u1',
      action: 'create',
      bookingId: 'b-1',
      restaurantId: 'r-1',
      details: 'party of 4, 19:00',
    });
    const entries = readAudit(db, 'b-1');
    assert.equal(entries[0].details, 'party of 4, 19:00');
  });
});
