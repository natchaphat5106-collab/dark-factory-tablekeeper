/**
 * The booking write path: reserve, cancel, read.
 *
 * This module is the only writer of `occupancy` in the whole service, at every stage.
 * The double-booking guarantee is not implemented here: it is implemented by the
 * primary key in schema.sql. This module's job is to turn that guarantee into an
 * answer — one booking survives, the rest get a refused request — and to do it
 * inside one transaction so a multi-table booking is all-or-nothing.
 *
 * Everything that writes runs inside BEGIN IMMEDIATE (see db.ts). That matters: with a
 * deferred transaction, two processes can both read "the slot is free" and only
 * collide at COMMIT, which in WAL is the wrong error at the wrong time. With an
 * immediate one, the store hands out the write lock in a defined order.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ApiError, isOccupancyKeyViolation } from './errors.ts';
import { inImmediateTransaction, type Db, type TxOptions } from './db.ts';
import {
  assertOnQuantumGrid,
  assertDuration,
  assertPartySize,
  quantumStarts,
} from './slots.ts';
import { formatInstant, resolveLocalStartInstant } from './timezone.ts';

export type ReserveRequest = {
  restaurantId: string;
  tableIds: string[];
  partySize: number;
  localStart: string;
  durationMin: number;
  idempotencyKey?: string | undefined;
  fold?: unknown;
};

export type ReserveResult =
  | { replayed: true; booking: BookingView }
  | { replayed: false; booking: BookingView };

export type BookingView = {
  id: string;
  restaurant_id: string;
  party_size: number;
  start_utc: string;
  duration_min: number;
  status: 'confirmed' | 'cancelled';
  created_at_utc: string;
};

type BookingRow = {
  id: string;
  restaurant_id: string;
  party_size: number;
  start_utc: string;
  duration_min: number;
  status: string;
  created_at_utc: string;
};

const BOOKING_COLUMNS =
  'id, restaurant_id, party_size, start_utc, duration_min, status, created_at_utc';

function toView(row: BookingRow): BookingView {
  return {
    id: row.id,
    restaurant_id: row.restaurant_id,
    party_size: row.party_size,
    start_utc: row.start_utc,
    duration_min: row.duration_min,
    status: row.status as BookingView['status'],
    created_at_utc: row.created_at_utc,
  };
}

/**
 * A stable hash of the semantically meaningful request fields.
 *
 * `table_ids` is sorted because a party seated at tables A and B is the same booking as
 * one seated at B and A; `fold` and `idempotency_key` are included/excluded on purpose.
 * Two requests sharing a key but differing in any of these are different bookings, so
 * replaying one as the other would be a lie.
 */
export function requestFingerprint(request: {
  restaurantId: string;
  tableIds: string[];
  partySize: number;
  localStart: string;
  durationMin: number;
  fold?: unknown;
}): string {
  const canonical = {
    restaurant_id: request.restaurantId,
    table_ids: [...request.tableIds].sort(),
    party_size: request.partySize,
    local_start: request.localStart,
    duration_min: request.durationMin,
    fold: request.fold === undefined ? null : request.fold,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function requireText(value: unknown, field: string, code: 'INVALID_TABLE' | 'NOT_FOUND'): string {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(code, `${field} must be a non-empty string`, { [field]: String(value) });
  }
  return value;
}

function normalizeTableIds(tableIds: unknown): string[] {
  if (!Array.isArray(tableIds) || tableIds.length === 0) {
    throw new ApiError('INVALID_TABLE', 'table_ids must be a non-empty array', {
      table_ids: String(tableIds),
    });
  }
  const ids = tableIds.map((id) => requireText(id, 'table_ids', 'INVALID_TABLE'));
  if (new Set(ids).size !== ids.length) {
    throw new ApiError('INVALID_TABLE', 'table_ids must not repeat a table', { table_ids: ids });
  }
  return ids;
}

export function reserve(
  db: Db,
  request: ReserveRequest,
  txOptions: TxOptions = {},
): ReserveResult {
  const tableIds = normalizeTableIds(request.tableIds);
  const partySize = assertPartySize(request.partySize);
  const durationMin = assertDuration(request.durationMin);
  // An idempotency key is only useful if it round-trips to the same key. A number or an
  // object here would be coerced by SQLite's TEXT affinity into something the caller did
  // not send, and two such requests would collide on a key neither of them chose.
  const idempotencyKey =
    request.idempotencyKey === undefined
      ? undefined
      : requireText(request.idempotencyKey, 'idempotency_key', 'INVALID_TABLE');

  return inImmediateTransaction(
    db,
    () => {
      // Read the key first. A retry of an already-accepted request is a replay, not a
      // second booking, and it must be answered before the occupancy insert can refuse it.
      const fingerprint = requestFingerprint({
        restaurantId: request.restaurantId,
        tableIds,
        partySize,
        localStart: request.localStart,
        durationMin,
        fold: request.fold,
      });
      if (idempotencyKey !== undefined) {
        const existing = db
          .prepare('SELECT request_fingerprint, booking_id FROM idempotency_key WHERE key = ?')
          .get(idempotencyKey);
        if (existing !== undefined) {
          const storedFingerprint = String((existing as { request_fingerprint: unknown }).request_fingerprint);
          const bookingId = String((existing as { booking_id: unknown }).booking_id);
          if (storedFingerprint !== fingerprint) {
            throw new ApiError('KEY_REUSED', 'idempotency_key was already used for a different request', {
              idempotency_key: idempotencyKey,
            });
          }
          return { replayed: true, booking: readBookingRow(db, bookingId) };
        }
      }

      const restaurantId = requireText(request.restaurantId, 'restaurant_id', 'NOT_FOUND');
      const restaurant = db
        .prepare('SELECT id, timezone FROM restaurant WHERE id = ?')
        .get(restaurantId) as { id: string; timezone: string } | undefined;
      if (restaurant === undefined) {
        throw new ApiError('NOT_FOUND', 'no such restaurant', { restaurant_id: restaurantId });
      }

      const startUtc = resolveLocalStartInstant(request.localStart, restaurant.timezone, request.fold);
      assertOnQuantumGrid(startUtc, 'local_start');

      // Scoped to the booking's own restaurant, not merely to the table id. A table id on
      // its own is not an authority to book it: any holder of the string could otherwise
      // squat that table's occupancy under a different restaurant and be told 201, and the
      // owning restaurant would then get 409 on its own inventory. The scoping lives in
      // the query because schema.sql cannot express it.
      const readTable = db.prepare('SELECT id, seats FROM dining_table WHERE id = ? AND restaurant_id = ?');
      for (const tableId of tableIds) {
        const table = readTable.get(tableId, restaurantId) as { id: string; seats: number } | undefined;
        if (table === undefined || table.id === undefined || table.seats === undefined) {
          throw new ApiError('INVALID_TABLE', 'no such table in this restaurant', { table_id: tableId });
        }
        if (partySize > table.seats) {
          throw new ApiError('TABLE_TOO_SMALL', 'party_size exceeds the seats at this table', {
            table_id: tableId,
            party_size: partySize,
            seats: table.seats,
          });
        }
      }

      const quanta = quantumStarts(startUtc, durationMin);
      const bookingId = randomUUID();
      db.prepare(
        `INSERT INTO booking (${BOOKING_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'confirmed', ?)`,
      ).run(bookingId, restaurantId, partySize, startUtc, durationMin, formatInstant(Date.now()));

      // One row per quantum, per table. This is the check: no availability query, no
      // in-process mutex, no lock manager. If a concurrent booking already owns a
      // quantum, the primary key refuses this insert and the whole transaction unwinds.
      const insertOccupancy = db.prepare(
        'INSERT INTO occupancy (dining_table_id, quantum_start_utc, booking_id) VALUES (?, ?, ?)',
      );
      for (const tableId of tableIds) {
        for (const quantum of quanta) {
          try {
            insertOccupancy.run(tableId, quantum, bookingId);
          } catch (err) {
            if (isOccupancyKeyViolation(err)) {
              throw new ApiError('SLOT_TAKEN', 'one of the requested tables is already booked', {
                table_id: tableId,
                quantum_start_utc: quantum,
              });
            }
            throw err;
          }
        }
      }

      if (idempotencyKey !== undefined) {
        db.prepare('INSERT INTO idempotency_key (key, request_fingerprint, booking_id) VALUES (?, ?, ?)').run(
          idempotencyKey,
          fingerprint,
          bookingId,
        );
      }

      return { replayed: false, booking: readBookingRow(db, bookingId) };
    },
    txOptions,
  );
}

function readBookingRow(db: Db, bookingId: string): BookingView {
  const row = db.prepare(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id = ?`).get(bookingId) as
    | BookingRow
    | undefined;
  if (row === undefined || row.id === undefined) {
    throw new ApiError('NOT_FOUND', 'no such booking', { booking_id: bookingId });
  }
  return toView(row);
}

export function getBooking(db: Db, bookingId: string): BookingView {
  const id = requireText(bookingId, 'booking_id', 'NOT_FOUND');
  const row = db.prepare(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id = ?`).get(id) as
    | BookingRow
    | undefined;
  if (row === undefined || row.id === undefined) {
    throw new ApiError('NOT_FOUND', 'no such booking', { booking_id: id });
  }
  return toView(row);
}

/**
 * Free a booking's tables. Deleting occupancy rows and marking the booking cancelled
 * happen in one transaction, so a cancelled booking is never half-freed and a confirmed
 * one never has its tables back. Deleting an unknown or already-cancelled booking is a
 * 404, so a repeated cancel is not a silent success.
 */
export function cancelBooking(db: Db, bookingId: string, txOptions: TxOptions = {}): void {
  const id = requireText(bookingId, 'booking_id', 'NOT_FOUND');
  inImmediateTransaction(
    db,
    () => {
      const row = db.prepare('SELECT id, status FROM booking WHERE id = ?').get(id) as
        | { id: string; status: string }
        | undefined;
      if (row === undefined || row.id === undefined || row.status !== 'confirmed') {
        throw new ApiError('NOT_FOUND', 'no confirmed booking with that id', { booking_id: id });
      }
      db.prepare('DELETE FROM occupancy WHERE booking_id = ?').run(id);
      db.prepare("UPDATE booking SET status = 'cancelled' WHERE id = ?").run(id);
    },
    txOptions,
  );
}