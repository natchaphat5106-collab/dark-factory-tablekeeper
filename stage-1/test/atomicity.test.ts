/**
 * Atomicity: a booking is written whole or not at all, and a cancellation frees exactly
 * the quanta it owned.
 *
 * The conflict cases deliberately start at a *different* minute than the booking that is
 * already in the way. A start-keyed occupancy implementation — one row per booking
 * instead of one row per quantum — passes a test that reuses the identical start and
 * fails this one, because 19:00 and 19:30 ninety-minute bookings share three quanta.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SQLInputValue } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server.ts';

let dir: string;
let service: StartedServer;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-atomic-'));
  service = await startServer(join(dir, 'stage1.db'));
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

function rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return service.db.prepare(sql).all(...params) as T[];
}

function occupancy(): { dining_table_id: string; quantum_start_utc: string; booking_id: string }[] {
  return rows('SELECT dining_table_id, quantum_start_utc, booking_id FROM occupancy ORDER BY dining_table_id, quantum_start_utc');
}

async function fixture(seats: number): Promise<{ restaurantId: string; tableIds: string[] }> {
  const restaurantId = (
    (
      await post('/v1/restaurants', { name: 'Atomicity Cafe', timezone: 'UTC' })
    ) as { id: string }
  ).id;
  const tableIds: string[] = [];
  for (let index = 0; index < seats; index += 1) {
    tableIds.push(((await post(`/v1/restaurants/${restaurantId}/tables`, { seats: 4 })) as { id: string }).id);
  }
  return { restaurantId, tableIds };
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return {
    __status: response.status,
    ...(raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)),
  };
}

test('a multi-table booking writes one occupancy row per table per quantum', async () => {
  const { restaurantId, tableIds } = await fixture(3);
  const result = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableIds[0], tableIds[1]],
    party_size: 4,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  });
  assert.equal(result.__status, 201);

  const bookingId = result.id as string;
  const written = occupancy().filter((row) => row.booking_id === bookingId);
  const expected = [
    '2026-06-15T19:00:00.000Z',
    '2026-06-15T19:15:00.000Z',
    '2026-06-15T19:30:00.000Z',
    '2026-06-15T19:45:00.000Z',
    '2026-06-15T20:00:00.000Z',
    '2026-06-15T20:15:00.000Z',
  ];
  assert.deepEqual(
    written.filter((row) => row.dining_table_id === tableIds[0]).map((row) => row.quantum_start_utc),
    expected,
  );
  assert.deepEqual(
    written.filter((row) => row.dining_table_id === tableIds[1]).map((row) => row.quantum_start_utc),
    expected,
  );
  assert.equal(written.length, 12);
  // The third table was not requested and must be untouched.
  assert.equal(written.filter((row) => row.dining_table_id === tableIds[2]).length, 0);
});

test('a conflict on the second table rolls back the whole booking, leaving no trace', async () => {
  const { restaurantId, tableIds } = await fixture(3);
  const [blocked, contested, free] = tableIds as [string, string, string];

  const first = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [blocked],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  });
  assert.equal(first.__status, 201);
  const bookingCountBefore = rows<{ n: number }>('SELECT count(*) AS n FROM booking')[0]?.n;
  const keyCountBefore = rows<{ n: number }>('SELECT count(*) AS n FROM idempotency_key')[0]?.n;
  const occupancyBefore = occupancy().length;

  // Starts at 19:30, so it shares 19:30, 19:45, 20:00 and 20:15 with the first booking.
  const rejected = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [contested, blocked],
    party_size: 4,
    local_start: '2026-06-15T19:30',
    duration_min: 90,
    idempotency_key: 'rolled-back-key',
  });
  assert.equal(rejected.__status, 409);
  assert.equal((rejected.error as { code: string }).code, 'SLOT_TAKEN');
  assert.equal((rejected.error as { details: { quantum_start_utc: string } }).details.quantum_start_utc, '2026-06-15T19:30:00.000Z');

  assert.equal(rows<{ n: number }>('SELECT count(*) AS n FROM booking')[0]?.n, bookingCountBefore, 'no booking row');
  assert.equal(rows<{ n: number }>('SELECT count(*) AS n FROM idempotency_key')[0]?.n, keyCountBefore, 'no idempotency key');
  assert.equal(occupancy().length, occupancyBefore, 'no occupancy rows added');
  assert.equal(occupancy().filter((row) => row.dining_table_id === contested).length, 0, 'the free table stayed free');
  assert.equal(occupancy().filter((row) => row.dining_table_id === free).length, 0);

  // The rolled-back booking left the contested table genuinely free for a later attempt.
  const afterwards = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [contested],
    party_size: 4,
    local_start: '2026-06-15T19:30',
    duration_min: 90,
  });
  assert.equal(afterwards.__status, 201);
});

test('a conflict on the first table rolls back just as completely', async () => {
  const { restaurantId, tableIds } = await fixture(2);
  const [blocked, free] = tableIds as [string, string];

  await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [blocked],
    party_size: 2,
    local_start: '2026-06-15T20:00',
    duration_min: 60,
  });
  const occupancyBefore = occupancy().length;
  const bookingCountBefore = rows<{ n: number }>('SELECT count(*) AS n FROM booking')[0]?.n;

  const rejected = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [blocked, free],
    party_size: 4,
    local_start: '2026-06-15T20:15',
    duration_min: 60,
  });
  assert.equal(rejected.__status, 409);
  assert.equal(rows<{ n: number }>('SELECT count(*) AS n FROM booking')[0]?.n, bookingCountBefore);
  assert.equal(occupancy().length, occupancyBefore);
  assert.equal(occupancy().filter((row) => row.dining_table_id === free).length, 0);
});

test('cancelling frees exactly the cancelled booking quanta and nothing else', async () => {
  const { restaurantId, tableIds } = await fixture(2);
  const [first, second] = tableIds as [string, string];

  const cancelled = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [first],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  });
  assert.equal(cancelled.__status, 201);

  const keeper = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [second],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  });
  assert.equal(keeper.__status, 201);
  const keeperId = keeper.id as string;
  assert.equal(occupancy().filter((row) => row.booking_id === keeperId).length, 6);

  const response = await fetch(`${base}/v1/bookings/${cancelled.id as string}`, { method: 'DELETE' });
  assert.equal(response.status, 204);

  const remaining = occupancy().filter((row) => row.dining_table_id === second);
  assert.deepEqual([...new Set(remaining.map((row) => row.booking_id))], [keeperId], 'only the other booking holds rows');
  assert.equal(remaining.length, 6);
  assert.deepEqual(
    remaining.map((row) => row.quantum_start_utc),
    [
      '2026-06-15T19:00:00.000Z',
      '2026-06-15T19:15:00.000Z',
      '2026-06-15T19:30:00.000Z',
      '2026-06-15T19:45:00.000Z',
      '2026-06-15T20:00:00.000Z',
      '2026-06-15T20:15:00.000Z',
    ],
  );
  assert.equal(
    rows<{ status: string }>('SELECT status FROM booking WHERE id = ?', cancelled.id as string)[0]?.status,
    'cancelled',
    'the booking row is kept and marked cancelled',
  );

  // The freed slot is bookable again at the identical start, and the untouched table is
  // still busy — the cancellation freed its own quanta, not everyone's.
  const rebooked = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [first],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  });
  assert.equal(rebooked.__status, 201);
  assert.notEqual(rebooked.id, cancelled.id);

  const secondTableAgain = await post('/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [second],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  });
  assert.equal(secondTableAgain.__status, 409);
  assert.equal((secondTableAgain.error as { code: string }).code, 'SLOT_TAKEN');
});