/**
 * The HTTP surface: every route in the task's table, every failure code, the error
 * envelope shape, and the promise that a listener is released.
 *
 * The last test in this file turns "every failure code is reachable" from a claim in a
 * document into an assertion: if a code in the taxonomy is never produced by any test in
 * this file, this file fails.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ERROR_STATUS, type ErrorCode } from '../src/errors.ts';
import { MAX_DURATION_MINUTES } from '../src/slots.ts';
import { openDatabase } from '../src/db.ts';
import { startServer, type StartedServer } from '../src/server.ts';

let dir: string;
let service: StartedServer;
let base: string;

const observedCodes = new Set<ErrorCode | 'INTERNAL'>();

type Call = { status: number; body: Record<string, unknown> | null; raw: string };

async function call(method: string, path: string, body?: unknown, port?: number): Promise<Call> {
  const origin = port === undefined ? base : `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  if (response.status >= 400) {
    const parsed = JSON.parse(raw) as { error?: { code?: ErrorCode } };
    if (parsed.error?.code !== undefined) observedCodes.add(parsed.error.code);
  }
  return { status: response.status, body: raw === '' ? null : (JSON.parse(raw) as Record<string, unknown>), raw };
}

function errorCode(callResult: Call): string {
  const error = callResult.body?.error as { code?: string } | undefined;
  return error?.code ?? '<missing>';
}

function assertEnvelope(callResult: Call): { code: string; message: string; details: Record<string, unknown> } {
  assert.deepEqual(Object.keys(callResult.body ?? {}), ['error']);
  const error = (callResult.body as { error: Record<string, unknown> }).error;
  assert.deepEqual(Object.keys(error).sort(), ['code', 'details', 'message']);
  assert.equal(typeof error.code, 'string');
  assert.equal(typeof error.message, 'string');
  assert.equal(typeof error.details, 'object');
  assert.ok(error.details !== null);
  return error as { code: string; message: string; details: Record<string, unknown> };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-http-'));
  service = await startServer(join(dir, 'stage1.db'));
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  const releasedPort = service.port;
  await service.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(service.server.listening, false, 'the listener must be closed');
  // A leaked listener is a failure, so prove the port was actually given back.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(releasedPort, '127.0.0.1', () => {
      probe.close(() => {
        resolve();
      });
    });
  });
});

test('GET /health answers before any other route and touches no state', async () => {
  const result = await call('GET', '/health');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: 'ok' });
  assert.equal(result.raw, '{"status":"ok"}');
});

test('POST /v1/restaurants creates a restaurant and rejects an unresolvable zone', async () => {
  const created = await call('POST', '/v1/restaurants', { name: 'Corner Bistro', timezone: 'America/New_York' });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body as object), ['id']);
  assert.equal(typeof (created.body as { id: string }).id, 'string');

  const bad = await call('POST', '/v1/restaurants', { name: 'Nowhere', timezone: 'Mars/Olympus_Mons' });
  assert.equal(bad.status, 400);
  assert.equal(errorCode(bad), 'INVALID_TIMEZONE');
  assertEnvelope(bad);
});

test('POST /v1/restaurants/:id/tables creates a table, 404s on an unknown restaurant', async () => {
  const restaurantId = ((await call('POST', '/v1/restaurants', { name: 'T', timezone: 'UTC' })).body as {
    id: string;
  }).id;

  const created = await call('POST', `/v1/restaurants/${restaurantId}/tables`, { seats: 6 });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body as object), ['id']);

  const missing = await call('POST', '/v1/restaurants/no-such-restaurant/tables', { seats: 6 });
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing), 'NOT_FOUND');
  assertEnvelope(missing);
});

test('POST /v1/bookings reserves a table and GET returns the same booking', async () => {
  const { restaurantId, tableId } = await fixture('Europe/Paris', 4);
  const booking = {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 3,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  };
  const created = await call('POST', '/v1/bookings', booking);
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body as object).sort(), [
    'created_at_utc',
    'duration_min',
    'id',
    'party_size',
    'restaurant_id',
    'start_utc',
    'status',
  ]);
  const view = created.body as { id: string; start_utc: string; status: string; party_size: number };
  assert.equal(view.start_utc, '2026-06-15T17:00:00.000Z');
  assert.equal(view.status, 'confirmed');
  assert.equal(view.party_size, 3);

  const fetched = await call('GET', `/v1/bookings/${view.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, created.body);
});

test('GET /v1/bookings/:id 404s on an unknown booking', async () => {
  const missing = await call('GET', '/v1/bookings/no-such-booking');
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing), 'NOT_FOUND');
  assertEnvelope(missing);
});

test('DELETE /v1/bookings/:id cancels once, then 404s — never a silent double success', async () => {
  const { restaurantId, tableId } = await fixture('UTC', 4);
  const created = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
  });
  const bookingId = (created.body as { id: string }).id;

  const cancelled = await call('DELETE', `/v1/bookings/${bookingId}`);
  assert.equal(cancelled.status, 204);
  assert.equal(cancelled.raw, '');

  const fetched = await call('GET', `/v1/bookings/${bookingId}`);
  assert.equal((fetched.body as { status: string }).status, 'cancelled');

  const again = await call('DELETE', `/v1/bookings/${bookingId}`);
  assert.equal(again.status, 404);
  assert.equal(errorCode(again), 'NOT_FOUND');
  assertEnvelope(again);
});

test('POST /v1/bookings 409 SLOT_TAKEN with the contested quantum named', async () => {
  const { restaurantId, tableId } = await fixture('UTC', 4);
  const booking = {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
  };
  assert.equal((await call('POST', '/v1/bookings', booking)).status, 201);

  const taken = await call('POST', '/v1/bookings', { ...booking, local_start: '2026-06-15T19:45' });
  assert.equal(taken.status, 409);
  const error = assertEnvelope(taken);
  assert.equal(error.code, 'SLOT_TAKEN');
  assert.equal(error.details.quantum_start_utc, '2026-06-15T19:45:00.000Z');
  assert.equal(error.details.table_id, tableId);
});

test('POST /v1/bookings 409 TABLE_TOO_SMALL', async () => {
  const { restaurantId, tableId } = await fixture('UTC', 2);
  const tooBig = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 5,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
  });
  assert.equal(tooBig.status, 409);
  assert.equal(errorCode(tooBig), 'TABLE_TOO_SMALL');
  assertEnvelope(tooBig);
});

test('POST /v1/bookings 409 KEY_REUSED for the same key with a different body', async () => {
  const { restaurantId, tableId, secondTableId } = await fixture('UTC', 4);
  const first = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
    idempotency_key: 'reuse-probe',
  });
  assert.equal(first.status, 201);

  const reused = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [secondTableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
    idempotency_key: 'reuse-probe',
  });
  assert.equal(reused.status, 409);
  assert.equal(errorCode(reused), 'KEY_REUSED');
  assertEnvelope(reused);
});

test('POST /v1/bookings 400 INVALID_PARTY_SIZE', async () => {
  const { restaurantId, tableId } = await fixture('UTC', 4);
  const bad = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 0,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
  });
  assert.equal(bad.status, 400);
  assert.equal(errorCode(bad), 'INVALID_PARTY_SIZE');
  assertEnvelope(bad);
});

test('POST /v1/bookings 400 INVALID_DURATION for a duration off the 15-minute grid', async () => {
  const { restaurantId, tableId } = await fixture('UTC', 4);
  const bad = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 70,
  });
  assert.equal(bad.status, 400);
  assert.equal(errorCode(bad), 'INVALID_DURATION');
  assertEnvelope(bad);
});

test('POST /v1/bookings 400 INVALID_DURATION for a duration that is not a positive multiple of 15', async () => {
  const { restaurantId, tableId } = await fixture('UTC', 4);
  const bad = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: -30,
  });
  assert.equal(bad.status, 400);
  assert.equal(errorCode(bad), 'INVALID_DURATION');
  assertEnvelope(bad);
});

test('POST /v1/bookings 400 INVALID_DURATION when one request would demand unbounded work', async () => {
  // Every minute of duration is another occupancy row per table, written under the one
  // global write lock. Without a ceiling a single tiny request can demand arbitrarily
  // many rows and starve every other writer, so the ceiling is a resource bound, not a
  // tidiness rule. The number below is the one measured to write 100,040 rows in 360 ms.
  const { restaurantId, tableId } = await fixture('UTC', 4);
  const started = process.hrtime.bigint();
  const bad = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 1_500_000,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(bad.status, 400);
  assert.equal(errorCode(bad), 'INVALID_DURATION');
  const details = assertEnvelope(bad).details as { max_duration_minutes?: number };
  assert.equal(details.max_duration_minutes, MAX_DURATION_MINUTES);
  assert.ok(elapsedMs < 200, `refused in ${elapsedMs.toFixed(1)}ms, so the ceiling is checked before any work`);
  assert.equal(
    (service.db.prepare('SELECT count(*) AS n FROM occupancy WHERE dining_table_id = ?').get(tableId) as {
      n: number;
    }).n,
    0,
    'a refused duration writes nothing',
  );

  // The boundary itself must still work, or the ceiling is not a ceiling but a hole in
  // the contract: the longest permitted booking is a real booking.
  const boundary = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: MAX_DURATION_MINUTES,
  });
  assert.equal(boundary.status, 201, 'duration exactly at the ceiling is allowed');
  assert.equal(
    (service.db.prepare('SELECT count(*) AS n FROM occupancy WHERE dining_table_id = ?').get(tableId) as {
      n: number;
    }).n,
    MAX_DURATION_MINUTES / 15,
    'and it writes one row per quantum it covers',
  );
});

test('a table id is not an authority to book it: another restaurant gets 400 and the owner keeps its table', async () => {
  // Tenant isolation, on the rejected path. A dining_table id resolves to a real row no
  // matter who quotes it, so an unscoped lookup answers 201 and writes occupancy against
  // the foreign table — the owning restaurant then gets 409 on its own inventory, and
  // TABLE_TOO_SMALL leaks the foreign seat count. Two restaurants, and both halves matter:
  // the squatter is refused, and the victim is still bookable afterwards.
  const owner = await fixture('UTC', 4);
  const squatter = ((await call('POST', '/v1/restaurants', { name: 'Squatter', timezone: 'UTC' })).body as {
    id: string;
  }).id;

  const hijack = await call('POST', '/v1/bookings', {
    restaurant_id: squatter,
    table_ids: [owner.tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
  });
  assert.equal(hijack.status, 400, 'a foreign table id must not be bookable');
  assert.equal(errorCode(hijack), 'INVALID_TABLE');
  const details = assertEnvelope(hijack).details as { table_id?: string };
  assert.equal(details.table_id, owner.tableId);
  assert.ok(
    !JSON.stringify(hijack.body).includes('seats'),
    'the refusal must not leak the foreign table’s seat count',
  );

  // Nothing was written: the owner books its own table at the same instant with a 201.
  const legitimate = await call('POST', '/v1/bookings', {
    restaurant_id: owner.restaurantId,
    table_ids: [owner.tableId],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
  });
  assert.equal(legitimate.status, 201, 'the owning restaurant must still get its table');
  assert.equal(
    (service.db.prepare('SELECT count(*) AS n FROM occupancy WHERE dining_table_id = ?').get(owner.tableId) as {
      n: number;
    }).n,
    4,
    'only the legitimate booking owns occupancy',
  );
});

test('POST /v1/bookings 400 INVALID_TABLE for an unknown table', async () => {
  const { restaurantId } = await fixture('UTC', 4);
  const bad = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: ['no-such-table'],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
  });
  assert.equal(bad.status, 400);
  assert.equal(errorCode(bad), 'INVALID_TABLE');
  assertEnvelope(bad);
});

test('POST /v1/bookings 404 NOT_FOUND for an unknown restaurant', async () => {
  const bad = await call('POST', '/v1/bookings', {
    restaurant_id: 'no-such-restaurant',
    table_ids: ['whatever'],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
  });
  assert.equal(bad.status, 404);
  assert.equal(errorCode(bad), 'NOT_FOUND');
  assertEnvelope(bad);
});

test('POST /v1/bookings 400 INVALID_TIME for a spring-forward gap', async () => {
  const { restaurantId, tableId } = await fixture('America/New_York', 4);
  const gap = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-03-08T02:30',
    duration_min: 60,
  });
  assert.equal(gap.status, 400);
  assert.equal(errorCode(gap), 'INVALID_TIME');
  assertEnvelope(gap);
});

test('POST /v1/bookings 400 AMBIGUOUS_LOCAL_TIME for a fall-back overlap', async () => {
  const { restaurantId, tableId } = await fixture('America/New_York', 4);
  const ambiguous = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-11-01T01:30',
    duration_min: 60,
  });
  assert.equal(ambiguous.status, 400);
  assert.equal(errorCode(ambiguous), 'AMBIGUOUS_LOCAL_TIME');
  const details = (ambiguous.body as { error: { details: { candidates: string[] } } }).error.details;
  assert.deepEqual(details.candidates, ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
});

test('an unknown route and an unsupported method both answer in the error envelope', async () => {
  const unknown = await call('GET', '/v1/availability');
  assert.equal(unknown.status, 404);
  assert.equal(errorCode(unknown), 'NOT_FOUND');
  assertEnvelope(unknown);

  const wrongMethod = await call('GET', '/v1/restaurants');
  assert.equal(wrongMethod.status, 404);
  assert.equal(errorCode(wrongMethod), 'NOT_FOUND');
  assertEnvelope(wrongMethod);
});

test('an oversized body is refused with the 400 envelope, not a dead socket', async () => {
  // The caller must be able to read *why* it was refused. Destroying the socket the moment
  // the limit is crossed kills the connection before the handler writes the answer, so the
  // client sees a transport failure (fetch rejects with a TypeError) instead of the
  // envelope. This asserts both halves: the envelope arrives, and it says what happened.
  const payload = JSON.stringify({
    restaurant_id: 'r',
    table_ids: ['t'],
    party_size: 2,
    local_start: '2026-06-15T19:00',
    duration_min: 60,
    padding: 'x'.repeat(70 * 1024),
  });
  assert.ok(Buffer.byteLength(payload) > 64 * 1024, 'the body must actually exceed the limit');

  const response = await fetch(`${base}/v1/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  }).catch((err: unknown) => {
    throw new Error(`the client never received a response: ${String(err)}`);
  });
  const raw = await response.text();
  assert.equal(response.status, 400);
  const parsed = JSON.parse(raw) as { error?: { code?: string; details?: Record<string, unknown> } };
  observedCodes.add(parsed.error?.code as ErrorCode);
  assert.equal(parsed.error?.code, 'INVALID_TABLE');
  assert.equal(parsed.error?.details?.field, 'body');
  assert.match(String(parsed.error?.details?.message ?? raw), /exceeds 65536 bytes/);
});

test('an absurdly oversized body is still closed rather than drained forever', async () => {
  // The drain in readBody exists so the 400 can be delivered; it must not become an
  // unbounded read. Far past the drain limit the socket is dropped.
  const response = await fetch(`${base}/v1/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'y'.repeat(3 * 1024 * 1024),
  }).catch(() => null);
  assert.ok(
    response === null || response.status === 400,
    'the service either answers 400 or drops the socket, but never hangs',
  );
  // The service is still answering afterwards, so the abandon did not take it down.
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
});

test('a body that is not a JSON object is refused in the same envelope', async () => {
  const response = await fetch(`${base}/v1/bookings`, { method: 'POST', body: '{not json' });
  const raw = await response.text();
  assert.equal(response.status, 400);
  const parsed = JSON.parse(raw) as { error: { code: string; details: { field: string } } };
  assert.equal(parsed.error.code, 'INVALID_TABLE');
  assert.equal(parsed.error.details.field, 'body');
});

test('a writer that cannot take the write lock reports a retryable 503, never a success', async () => {
  const busyDir = mkdtempSync(join(tmpdir(), 'tablekeeper-busy-'));
  const busyPath = join(busyDir, 'busy.db');
  const blocker = openDatabase(busyPath);
  blocker.exec("INSERT INTO restaurant (id, name, timezone) VALUES ('r', 'Blocked', 'UTC')");
  blocker.exec("INSERT INTO dining_table (id, restaurant_id, seats) VALUES ('t', 'r', 4)");
  blocker.exec('BEGIN EXCLUSIVE');
  try {
    const squeezed = await startServer(busyPath, {
      busyTimeoutMs: 1,
      txOptions: { busyAttempts: 2, busyBackoffMs: 1 },
    });
    try {
      const result = await call(
        'POST',
        '/v1/bookings',
        {
          restaurant_id: 'r',
          table_ids: ['t'],
          party_size: 2,
          local_start: '2026-06-15T19:00',
          duration_min: 60,
        },
        squeezed.port,
      );
      assert.equal(result.status, 503);
      const error = assertEnvelope(result);
      assert.equal(error.code, 'BUSY_RETRY_EXHAUSTED');
      assert.equal(error.details.retryable, true);
    } finally {
      await squeezed.close();
    }
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    rmSync(busyDir, { recursive: true, force: true });
  }
});

test('an unexpected internal failure answers 500 INTERNAL without leaking the cause', async () => {
  // INTERNAL is in the taxonomy, so it must be reachable or the reachability test below
  // fails. Closing the handle under a live server is the honest way to provoke a throw
  // that is nobody's fault: the caller gets a 500 in the standard envelope and no detail
  // about SQLite's internals.
  const brokenDir = mkdtempSync(join(tmpdir(), 'tablekeeper-broken-'));
  const broken = await startServer(join(brokenDir, 'broken.db'));
  try {
    broken.db.close();
    const result = await call('POST', '/v1/bookings', {
      restaurant_id: 'r',
      table_ids: ['t'],
      party_size: 2,
      local_start: '2026-06-15T19:00',
      duration_min: 60,
    }, broken.port);
    assert.equal(result.status, 500);
    const error = assertEnvelope(result);
    assert.equal(error.code, 'INTERNAL');
    assert.deepEqual(error.details, {});
    assert.ok(
      !/sqlite|database|closed|connection/i.test(error.message),
      `the internal cause must not reach the caller: ${error.message}`,
    );
  } finally {
    // Not `broken.close()`: that closes the database a second time and node:sqlite throws
    // on a handle that is already closed. Close only the listener.
    await new Promise<void>((resolve) => {
      broken.server.close(() => resolve());
      broken.server.closeAllConnections();
    });
    rmSync(brokenDir, { recursive: true, force: true });
  }
});

test('every code in the error taxonomy is reachable over HTTP', () => {
  const missing = (Object.keys(ERROR_STATUS) as ErrorCode[]).filter((code) => !observedCodes.has(code));
  assert.deepEqual(missing, [], `unreachable failure codes: ${missing.join(', ')}`);
});

async function fixture(
  timezone: string,
  seats: number,
): Promise<{ restaurantId: string; tableId: string; secondTableId: string }> {
  const restaurantId = ((await call('POST', '/v1/restaurants', { name: `Fixture ${timezone}`, timezone })).body as {
    id: string;
  }).id;
  const tableId = ((await call('POST', `/v1/restaurants/${restaurantId}/tables`, { seats })).body as {
    id: string;
  }).id;
  const secondTableId = ((
    await call('POST', `/v1/restaurants/${restaurantId}/tables`, { seats })
  ).body as { id: string }).id;
  return { restaurantId, tableId, secondTableId };
}