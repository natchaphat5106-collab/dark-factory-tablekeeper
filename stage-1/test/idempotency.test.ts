/**
 * Idempotency: the same key delivered ten times at once produces one booking.
 *
 * A retry is the normal case in a reservation system, not an edge case — a client that
 * loses the response to a timeout will send it again. What must never happen is two
 * bookings for one request, and what must also never happen is a second request being
 * answered with the first one's result.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SQLInputValue } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.ts';
import { startServer, type StartedServer } from '../src/server.ts';

const SERVER_MODULE = new URL('../src/server.ts', import.meta.url).href;

/** A whole separate runtime per duplicate, so the race is the one a retry really produces. */
const DUPLICATE_WORKER_SOURCE = [
  `import { startServer } from ${JSON.stringify(SERVER_MODULE)};`,
  "import { existsSync, writeFileSync } from 'node:fs';",
  '',
  'const [dbPath, payload, readyDir, id, goPath] = process.argv.slice(2);',
  'const service = await startServer(dbPath, { port: 0 });',
  "const url = 'http://127.0.0.1:' + service.port + '/v1/bookings';",
  '',
  '// Warm the keep-alive connection with a deliberately invalid request and read the body,',
  '// so the real delivery goes out on an established socket. Connection setup is the largest',
  '// source of arrival jitter once boot time is removed; without this the winner can finish',
  '// before a slow socket has even been opened, and the race is not the one under test.',
  "await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.text());",
  '',
  '// Announce that this runtime is booted, then wait for the parent to release everyone at',
  '// once. The synchronization is a filesystem barrier, not a timestamp: process boot time',
  '// is tens to hundreds of milliseconds and varies with machine load, so a shared deadline',
  '// either leaves a straggler behind (a false "not a race") or forces a lead so long the',
  '// test crawls. The go-file removes boot time from the measurement entirely.',
  'writeFileSync(readyDir + "/ready-" + id, "");',
  'const deadline = Date.now() + 20000;',
  'while (!existsSync(goPath)) {',
  '  if (Date.now() > deadline) throw new Error("timed out waiting for the go signal");',
  '}',
  'const firedAt = Date.now();',
  "const response = await fetch('http://127.0.0.1:' + service.port + '/v1/bookings', {",
  "  method: 'POST',",
  "  headers: { 'content-type': 'application/json' },",
  '  body: payload,',
  '});',
  'const text = await response.text();',
  'let parsed = null;',
  'try { parsed = JSON.parse(text); } catch {}',
  'await service.close();',
  'process.stdout.write(JSON.stringify({',
  '  pid: process.pid,',
  '  status: response.status,',
  '  code: parsed && parsed.error ? parsed.error.code : null,',
  '  booking_id: parsed && parsed.id ? parsed.id : null,',
  '  fired_at: firedAt,',
  '}));',
  '',
].join('\n');

/** Distinct key/table rounds per run. The window a narrowed transaction opens is narrow. */
const DUPLICATE_ROUNDS = 8;
const DUPLICATE_RACERS = 10;
/** How long to wait for ten Node runtimes to boot and announce readiness. */
const RACER_BOOT_TIMEOUT_MS = 20_000;
/**
 * The same single floor as test/concurrency.test.ts, chosen from the tail measured under the
 * reduced configuration (rounds run one after another): across 480 samples the idempotency
 * spread peaked at 254 ms, so 1000 ms is a 3.9x margin. Duplicate delivery is proven
 * behaviourally (one booking, one key, one occupancy set); this guards only that the
 * deliveries overlap rather than arriving in sequence. One floor, one derivation.
 */
const MAX_FIRE_SPREAD_MS = 1000;

type DupeChild = {
  pid: number;
  status: number;
  code: string | null;
  booking_id: string | null;
  fired_at: number;
};

let dir: string;
let service: StartedServer;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-idem-'));
  service = await startServer(join(dir, 'stage1.db'));
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

type Result = { status: number; body: Record<string, unknown> };

function post(path: string, body: unknown): Promise<Result> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const raw = await response.text();
    return { status: response.status, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) };
  });
}

function count(sql: string, ...params: SQLInputValue[]): number {
  const row = service.db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

async function fixture(): Promise<{ restaurantId: string; tableId: string; otherTableId: string }> {
  const restaurantId = ((await post('/v1/restaurants', { name: 'Idem Bistro', timezone: 'UTC' })).body as {
    id: string;
  }).id;
  const tableId = ((await post(`/v1/restaurants/${restaurantId}/tables`, { seats: 4 })).body as {
    id: string;
  }).id;
  const otherTableId = ((await post(`/v1/restaurants/${restaurantId}/tables`, { seats: 4 })).body as {
    id: string;
  }).id;
  return { restaurantId, tableId, otherTableId };
}

test('the identical request delivered 10 times concurrently makes exactly one booking', async () => {
  const { restaurantId, tableId, otherTableId } = await fixture();
  const payload = {
    restaurant_id: restaurantId,
    table_ids: [tableId, otherTableId],
    party_size: 4,
    local_start: '2026-06-15T19:00',
    duration_min: 90,
    idempotency_key: 'concurrent-duplicate',
  };

  const responses = await Promise.all(Array.from({ length: 10 }, () => post('/v1/bookings', payload)));

  const created = responses.filter((response) => response.status === 201);
  const replayed = responses.filter((response) => response.status === 200);
  assert.equal(created.length, 1, `expected one 201, got ${responses.map((r) => r.status).join(',')}`);
  assert.equal(replayed.length, 9);

  const bookingIds = new Set(responses.map((response) => response.body.id));
  assert.equal(bookingIds.size, 1, 'every response must carry the same booking id');
  assert.equal([...bookingIds][0], created[0]?.body.id);

  // The store, not the response, is the thing being asserted: one booking, one row per
  // table per quantum, and no orphan rows.
  const winnerId = [...bookingIds][0] as string;
  assert.equal(count('SELECT count(*) AS n FROM booking WHERE id = ?', winnerId), 1);
  assert.equal(
    count(
      'SELECT count(*) AS n FROM booking WHERE restaurant_id = ? AND id <> ?',
      restaurantId,
      winnerId,
    ),
    0,
    'no second booking row for this restaurant',
  );
  const occupancyRows = service.db
    .prepare('SELECT dining_table_id, quantum_start_utc, booking_id FROM occupancy WHERE booking_id = ?')
    .all([...bookingIds][0] as string) as { dining_table_id: string; quantum_start_utc: string }[];
  assert.equal(occupancyRows.length, 12);
  assert.equal(occupancyRows.filter((row) => row.dining_table_id === tableId).length, 6);
  assert.equal(occupancyRows.filter((row) => row.dining_table_id === otherTableId).length, 6);
  assert.equal(
    count('SELECT count(*) AS n FROM occupancy o LEFT JOIN booking b ON b.id = o.booking_id WHERE b.id IS NULL'),
    0,
    'no orphan occupancy rows',
  );
  assert.equal(
    count('SELECT count(*) AS n FROM idempotency_key WHERE key = ?', 'concurrent-duplicate'),
    1,
    'one row for the key',
  );
});

test('the booking and its idempotency key are one write: a key that cannot be stored takes the booking with it', async () => {
  // This is the deterministic half of the cross-process proof. A duplicate window that is
  // only observable when two writers happen to interleave cannot be depended on, so pin the
  // property directly: force the key insert to fail and require the booking to vanish too.
  // If the key were written in its own transaction after the booking, the booking (and its
  // occupancy rows) would survive while the key did not — a state a retry could never replay.
  const atomicDir = mkdtempSync(join(tmpdir(), 'tablekeeper-idem-atomic-'));
  const atomic = await startServer(join(atomicDir, 'atomic.db'));
  try {
    const restaurantId = (
      (await fetch(`http://127.0.0.1:${String(atomic.port)}/v1/restaurants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Atomic Kitchen', timezone: 'UTC' }),
      }).then((r) => r.json())) as { id: string }
    ).id;
    const tableId = (
      (await fetch(`http://127.0.0.1:${String(atomic.port)}/v1/restaurants/${restaurantId}/tables`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seats: 4 }),
      }).then((r) => r.json())) as { id: string }
    ).id;

    // A trigger that refuses exactly one key, so the failure lands between the booking insert
    // and the key insert rather than before either of them.
    atomic.db.exec(
      "CREATE TRIGGER refuse_one_key BEFORE INSERT ON idempotency_key WHEN NEW.key = 'blocked-by-trigger' " +
        "BEGIN SELECT RAISE(ABORT, 'forced failure for the atomicity test'); END",
    );

    const response = await fetch(`http://127.0.0.1:${String(atomic.port)}/v1/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        restaurant_id: restaurantId,
        table_ids: [tableId],
        party_size: 2,
        local_start: '2026-06-15T19:00',
        duration_min: 60,
        idempotency_key: 'blocked-by-trigger',
      }),
    });
    await response.text();
    assert.equal(response.status, 500, 'the forced store failure is reported as a server error');

    const bookRows = atomic.db.prepare('SELECT count(*) AS n FROM booking').get() as { n: number };
    const occupancyRows = atomic.db.prepare('SELECT count(*) AS n FROM occupancy').get() as { n: number };
    const keyRows = atomic.db.prepare('SELECT count(*) AS n FROM idempotency_key').get() as { n: number };
    assert.equal(bookRows.n, 0, 'the booking must roll back with the key, not outlive it');
    assert.equal(occupancyRows.n, 0, 'no occupancy rows may survive the failed key write');
    assert.equal(keyRows.n, 0, 'the refused key was never stored');
  } finally {
    await atomic.close();
    rmSync(atomicDir, { recursive: true, force: true });
  }
});

/**
 * Deliver one payload from `racers` separate OS processes at the same instant.
 *
 * Each worker announces it is booted and then blocks on a go-file the parent writes only
 * once every worker is ready. Without that barrier the processes arrive in boot order and
 * the test cannot see a window that only exists while writers contend.
 */
async function deliverAcrossProcesses(
  workerPath: string,
  dbPath: string,
  payload: string,
  racers: number,
): Promise<DupeChild[]> {
  const round = mkdtempSync(join(tmpdir(), 'tablekeeper-idem-go-'));
  const goPath = join(round, 'go');
  const closing = Promise.all(
    Array.from({ length: racers }, (_unused, id) =>
      new Promise<DupeChild>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [workerPath, dbPath, payload, round, String(id), goPath],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`dupe pid ${String(child.pid)} exited ${String(code)}: ${stderr}`));
            return;
          }
          resolve(JSON.parse(stdout) as DupeChild);
        });
      }),
    ),
  );

  try {
    // Wait until every runtime has signalled readiness, then release them together. This
    // is the barrier that makes the deliveries overlap despite boot jitter.
    const readyDeadline = Date.now() + RACER_BOOT_TIMEOUT_MS;
    for (;;) {
      let ready = 0;
      for (let id = 0; id < racers; id += 1) {
        if (existsSync(join(round, 'ready-' + String(id)))) ready += 1;
      }
      if (ready === racers) break;
      if (Date.now() > readyDeadline) {
        throw new Error(`only ${String(ready)} of ${String(racers)} racers became ready in time`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(goPath, '');

    const children = await closing;
    const fired = children.map((child) => child.fired_at);
    const spread = Math.max(...fired) - Math.min(...fired);
    process.stdout.write(`    idempotency round fire spread ${String(spread)}ms\n`);
    assert.ok(
      spread < MAX_FIRE_SPREAD_MS,
      `the deliveries must actually overlap, not arrive in sequence (spread ${String(spread)}ms)`,
    );
    return children;
  } finally {
    rmSync(round, { recursive: true, force: true });
  }
}

test('the same key delivered by separate processes still makes exactly one booking', async () => {
  // The 10-way test above runs in one process, so it proves JS-level serialization: one
  // connection, one event loop, one writer at a time. A real retry is delivered by a
  // *different process* with its own runtime and its own connection, contending on the
  // database file. Nothing in the suite covered that, so narrowing the write path later
  // (a narrower transaction, a per-process cache) could regress silently.
  //
  // Repeated across several keys because the window a narrower transaction opens is narrow
  // by nature: one round can miss it, which is precisely why a single green run here would
  // be evidence of nothing.
  const racerDir = mkdtempSync(join(tmpdir(), 'tablekeeper-idem-race-'));
  const workerPath = join(racerDir, 'dupe.mjs');
  writeFileSync(workerPath, DUPLICATE_WORKER_SOURCE);
  const dbPath = join(racerDir, 'race.db');
  const restaurantId = 'restaurant-idem-race';

  const seeder = openDatabase(dbPath);
  try {
    seeder
      .prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)')
      .run(restaurantId, 'Dupe Diner', 'UTC');
    const insertTable = seeder.prepare(
      'INSERT INTO dining_table (id, restaurant_id, seats) VALUES (?, ?, ?)',
    );
    for (let round = 0; round < DUPLICATE_ROUNDS; round += 1) {
      insertTable.run(`table-round-${String(round)}`, restaurantId, 6);
    }
  } finally {
    seeder.close();
  }

  const racers = DUPLICATE_RACERS;
  try {
    for (let round = 0; round < DUPLICATE_ROUNDS; round += 1) {
      const tableId = `table-round-${String(round)}`;
      const key = `cross-process-duplicate-${String(round)}`;
      // A distinct day per round, so each round contests its own quanta and a booking
      // from an earlier round can never mask a failure in a later one.
      const day = 15 + round;
      const date = `2026-06-${String(day).padStart(2, '0')}`;
      const payload = JSON.stringify({
        restaurant_id: restaurantId,
        table_ids: [tableId],
        party_size: 2,
        local_start: `${date}T19:00`,
        duration_min: 90,
        idempotency_key: key,
      });

      const children = await deliverAcrossProcesses(workerPath, dbPath, payload, racers);
      const statuses = children.map((child) => child.status).sort();
      const created = children.filter((child) => child.status === 201);
      const replayed = children.filter((child) => child.status === 200);
      const round_ = round;

      assert.equal(
        new Set(children.map((child) => child.pid)).size,
        racers,
        `round ${String(round)}: ${String(racers)} distinct processes answered`,
      );
      assert.equal(
        created.length,
        1,
        `round ${String(round)}: expected one 201 across processes, got ${statuses.join(',')}`,
      );
      assert.equal(
        replayed.length,
        racers - 1,
        `round ${String(round)}: the rest must be replays, not refusals and not second bookings`,
      );
      assert.equal(
        new Set(children.map((child) => child.booking_id)).size,
        1,
        `round ${String(round)}: every process returned the same booking id`,
      );
      for (const child of children) {
        assert.ok(
          child.status === 201 || child.status === 200,
          `round ${String(round)}: a duplicate delivery must never be refused: pid ${String(child.pid)} answered ${String(child.status)} ${String(child.code)}`,
        );
      }

      const observer = openDatabase(dbPath);
      try {
        const bookings = observer
          .prepare('SELECT id FROM booking WHERE restaurant_id = ?')
          .all(restaurantId) as { id: string }[];
        assert.equal(
          bookings.length,
          round + 1,
          `round ${String(round)}: exactly one new booking row, checked in the file from a separate connection`,
        );
        assert.equal(
          (observer.prepare('SELECT count(*) AS n FROM idempotency_key WHERE key = ?').get(key) as { n: number }).n,
          1,
          `round ${String(round)}: one idempotency row`,
        );
        assert.equal(
          (observer
            .prepare('SELECT count(*) AS n FROM occupancy WHERE dining_table_id = ?')
            .get(tableId) as { n: number }).n,
          6,
          `round ${String(round)}: six quanta, written once`,
        );
      } finally {
        observer.close();
      }
      void round_;
    }
  } finally {
    rmSync(racerDir, { recursive: true, force: true });
  }
});

test('the same key with a different body is refused rather than silently replayed', async () => {
  const { restaurantId, tableId, otherTableId } = await fixture();
  const base = {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T20:00',
    duration_min: 60,
    idempotency_key: 'reused-key',
  };
  const first = await post('/v1/bookings', base);
  assert.equal(first.status, 201);

  const differentParty = await post('/v1/bookings', { ...base, party_size: 3 });
  assert.equal(differentParty.status, 409);
  assert.equal((differentParty.body.error as { code: string }).code, 'KEY_REUSED');

  const differentTable = await post('/v1/bookings', { ...base, table_ids: [otherTableId] });
  assert.equal(differentTable.status, 409);
  assert.equal((differentTable.body.error as { code: string }).code, 'KEY_REUSED');

  const differentStart = await post('/v1/bookings', { ...base, local_start: '2026-06-15T21:00' });
  assert.equal(differentStart.status, 409);
  assert.equal((differentStart.body.error as { code: string }).code, 'KEY_REUSED');

  assert.equal(count('SELECT count(*) AS n FROM booking WHERE restaurant_id = ?', restaurantId), 1);
});

test('table order does not change the request, so it replays instead of being refused', async () => {
  const { restaurantId, tableId, otherTableId } = await fixture();
  const payload = {
    restaurant_id: restaurantId,
    table_ids: [tableId, otherTableId],
    party_size: 4,
    local_start: '2026-06-15T22:00',
    duration_min: 60,
    idempotency_key: 'order-insensitive',
  };
  const first = await post('/v1/bookings', payload);
  assert.equal(first.status, 201);

  const reversed = await post('/v1/bookings', { ...payload, table_ids: [otherTableId, tableId] });
  assert.equal(reversed.status, 200);
  assert.equal(reversed.body.id, first.body.id);
});

test('a fresh key with an identical body is a new request and is refused on the occupied slot', async () => {
  const { restaurantId, tableId } = await fixture();
  const payload = {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-15T23:00',
    duration_min: 60,
  };
  const first = await post('/v1/bookings', { ...payload, idempotency_key: 'key-a' });
  assert.equal(first.status, 201);

  // Same body, different key: idempotency is per key, so this is a genuine second booking
  // attempt and must be judged on the slot, not quietly answered with the first booking.
  const second = await post('/v1/bookings', { ...payload, idempotency_key: 'key-b' });
  assert.equal(second.status, 409);
  assert.equal((second.body.error as { code: string }).code, 'SLOT_TAKEN');
  assert.notEqual(second.body.id, first.body.id);
});

test('a consumed key is never released, even after the booking is cancelled', async () => {
  const { restaurantId, tableId } = await fixture();
  const payload = {
    restaurant_id: restaurantId,
    table_ids: [tableId],
    party_size: 2,
    local_start: '2026-06-16T19:00',
    duration_min: 60,
    idempotency_key: 'sticky-key',
  };
  const first = await post('/v1/bookings', payload);
  assert.equal(first.status, 201);

  const cancelled = await fetch(`${base}/v1/bookings/${first.body.id as string}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 204);

  const retry = await post('/v1/bookings', payload);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(count('SELECT count(*) AS n FROM booking WHERE restaurant_id = ?', restaurantId), 1);
  assert.equal(count('SELECT count(*) AS n FROM occupancy WHERE dining_table_id = ?', tableId), 0);
});