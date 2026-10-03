/**
 * Stage 3 — Audit trail.
 *
 * Append-only log of every state change to a booking.
 * One row per action (create/cancel/reschedule).
 * Never edited. Never deleted.
 */

import type { Db } from '../../stage-1/src/db.ts';

export type AuditAction = 'create' | 'cancel' | 'reschedule';

export type AuditEntry = {
  id: number;
  ts_utc: string;
  actor: string;
  action: AuditAction;
  booking_id: string;
  restaurant_id: string;
  details: string;
};

export function migrateAudit(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_utc TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create','cancel','reschedule')),
      booking_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_audit_booking ON audit_log(booking_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts_utc);
  `);
}

export function writeAudit(
  db: Db,
  entry: {
    actor: string;
    action: AuditAction;
    bookingId: string;
    restaurantId: string;
    details?: string;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (ts_utc, actor, action, booking_id, restaurant_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.actor,
    entry.action,
    entry.bookingId,
    entry.restaurantId,
    entry.details ?? '',
  );
}

export function readAudit(db: Db, bookingId: string): AuditEntry[] {
  return db
    .prepare(
      `SELECT id, ts_utc, actor, action, booking_id, restaurant_id, details
       FROM audit_log WHERE booking_id = ? ORDER BY id ASC`,
    )
    .all(bookingId) as AuditEntry[];
}

export function readAllAudit(db: Db, limit = 100): AuditEntry[] {
  return db
    .prepare(
      `SELECT id, ts_utc, actor, action, booking_id, restaurant_id, details
       FROM audit_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as AuditEntry[];
}
