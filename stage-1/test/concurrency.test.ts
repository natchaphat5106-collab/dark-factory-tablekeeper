/**
 * The concurrency proof.
 *
 * Twelve *separate OS processes* — spawned with child_process, each with its own Node
 * runtime, its own HTTP server and its own connection — race for the same table in the
 * same slot in the same database *file*. Exactly one must win.
 *
 * Threads would prove nothing: a mutex or one shared connection would hide exactly the
 * failure this stage exists to prevent. An in-memory database would prove nothing
 * either, because there is no file for another process to contend on.
 *
 * The race is repeated three times with three different booking starts, none of which is on
 * the hour, so nothing here can pass by accident because the run happened to land on a round
 * boundary. The racers are released by a filesystem barrier, not a wall-clock deadline, so
 * process boot time is not mistaken for the contention window.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.ts';

const RACERS = 12;
/** How long to wait for twelve Node runtimes to boot and announce readiness. */
const RACER_BOOT_TIMEOUT_MS = 20_000;
/**
 * The shared floor for how far apart two racers' deliveries may land once the go-file has
 * released them together. Chosen from the tail actually measured under the reduced
 * configuration (the three repetitions serialised, go-file barrier): across 240 samples the
 * spread in this file peaked at 186 ms, so 1000 ms is a 5.4x margin and still sits far
 * inside one 15-minute quantum. Overlap is not inferred from this number — the proof is
 * the per-racer SQLITE_BUSY retry count. This is only a guard that the harness is still
 * racing; a site may exceed it only for a measured reason. One floor, one derivation:
 * identical to test/idempotency.test.ts.
 */
const MAX_FIRE_SPREAD_MS = 1000;

const REPETITIONS = [
  { localStart: '2026-06-15T19:15' },
  { localStart: '2026-06-15T19:45' },
  { localStart: '2026-06-15T20:15' },
];

const SERVER_MODULE = new URL('../src/server.ts', import.meta.url).href;
const DB_MODULE = new URL('../src/db.ts', import.meta.url).href;

/**
 * A worker that only opens the database. Used for the cold-start migration race: with no
 * seeder, every process is the first migrator, so the BEGIN in migrate() is genuinely
 * contended.
 */
const OPENER_SOURCE = [
  `import { openDatabase } from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};`,
  "import { existsSync, writeFileSync } from 'node:fs';",
  '',
  'const [dbPath, readyDir, id, goPath] = process.argv.slice(2);',
  '// A release barrier, not a wall-clock deadline: process boot time varies with load, so an',
  '// absolute fire time measures how late a runtime booted, not whether the openers overlapped.',
  'writeFileSync(readyDir + "/ready-" + id, "");',
  'const deadline = Date.now() + 20000;',
  'while (!existsSync(goPath)) {',
  '  if (Date.now() > deadline) throw new Error("timed out waiting for the go signal");',
  '}',
  'const firedAt = Date.now();',
  'let error = null;',
  'let tables = [];',
  'try {',
  '  const db = openDatabase(dbPath);',
  "  tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map((row) => row.name);",
  '  db.close();',
  '} catch (err) {',
  '  error = String(err && err.message ? err.message : err);',
  '}',
  'process.stdout.write(JSON.stringify({ pid: process.pid, fired_at: firedAt, tables, error }));',
  '',
].join('\n');

const WORKER_SOURCE = [
  `import { startServer } from ${JSON.stringify(SERVER_MODULE)};`,
  `import { busyRetryCount } from ${JSON.stringify(DB_MODULE)};`,
  "import { existsSync, writeFileSync } from 'node:fs';",
  '',
  'const [dbPath, payload, readyDir, id, goPath] = process.argv.slice(2);',
  '',
  '// A one-millisecond busy_timeout, with a generous retry budget, is the whole point of the',
  '// overlap proof. With the 5000 ms default SQLite waits out the contention internally and',
  '// this process never sees SQLITE_BUSY, so there is nothing to count. With a short timeout',
  '// the collision surfaces at the retry sites in db.ts and the count becomes a real fact.',
  'const service = await startServer(dbPath, {',
  '  port: 0,',
  '  busyTimeoutMs: 1,',
  '  txOptions: { busyAttempts: 300, busyBackoffMs: 1 },',
  '});',
  '',
  '// Announce that this runtime is booted, then wait for the parent to release every racer',
  '// at once. A shared timestamp cannot do this: process boot time is tens to hundreds of',
  '// milliseconds and varies with load, so whichever racer boots last fires late and looks',
  '// like a non-race. The go-file removes boot time from the measurement entirely.',
  'writeFileSync(readyDir + "/ready-" + id, "");',
  'const deadline = Date.now() + 20000;',
  'while (!existsSync(goPath)) {',
  '  if (Date.now() > deadline) throw new Error("timed out waiting for the go signal");',
  '}',
  'const firedAt = Date.now();',
  '',
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
  '  busy_retries: busyRetryCount(),',
  '}));',
  '',
].join('\n');

type ChildResult = {
  pid: number;
  status: number;
  code: string | null;
  booking_id: string | null;
  fired_at: number;
  /**
   * How many times this process's write loop re-entered on SQLITE_BUSY. This is the
   * overlap evidence: it is a fact about the database, not about how close two clocks are.
   */
  busy_retries: number;
};

let dir: string;
let workerPath: string;
let openerPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-race-'));
  workerPath = join(dir, 'racer.mjs');
  openerPath = join(dir, 'opener.mjs');
  writeFileSync(workerPath, WORKER_SOURCE);
  writeFileSync(openerPath, OPENER_SOURCE);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function spawnRacer(
  dbPath: string,
  payload: string,
  readyDir: string,
  id: number,
  goPath: string,
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [workerPath, dbPath, payload, readyDir, String(id), goPath],
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
        reject(new Error(`racer pid ${String(child.pid)} exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as ChildResult);
    });
  });
}

type RaceSpec = {
  label: string;
  racers: number;
  localStart: string;
  tablesFor: (index: number) => string[];
  /** Every table id that exists in this race's database. */
  knownTables: string[];
  durationMin: number;
};

type RaceReport = {
  label: string;
  localStart: string;
  fireAt: number;
  children: ChildResult[];
  created: ChildResult[];
  refused: ChildResult[];
  fireSpreadMs: number;
  distinctPids: number;
  occupancyRows: number;
  bookingRows: number;
  orphanRows: number;
  strayRows: number;
  /** Rows on a table that exists but that no racer ever requested. Must be 0. */
  untouchedRows: number;
  winnerIds: string[];
  quantaPerWinner: number;
};

async function race(spec: RaceSpec): Promise<RaceReport> {
  const raceDir = join(dir, spec.label);
  rmSync(raceDir, { recursive: true, force: true });
  mkdirSync(raceDir, { recursive: true });
  const dbPath = join(raceDir, 'race.db');

  const restaurantId = `restaurant-${spec.label}`;
  const seeder = openDatabase(dbPath);
  try {
    seeder
      .prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)')
      .run(restaurantId, 'Race Hall', 'UTC');
    const insertTable = seeder.prepare(
      'INSERT INTO dining_table (id, restaurant_id, seats) VALUES (?, ?, ?)',
    );
    for (const tableId of spec.knownTables) insertTable.run(tableId, restaurantId, 6);
  } finally {
    seeder.close();
  }

  const readyDir = join(raceDir, 'ready');
  mkdirSync(readyDir, { recursive: true });
  const goPath = join(raceDir, 'go');

  const closing = Promise.all(
    Array.from({ length: spec.racers }, (_unused, index) =>
      spawnRacer(
        dbPath,
        JSON.stringify({
          restaurant_id: restaurantId,
          table_ids: spec.tablesFor(index),
          party_size: 2,
          local_start: spec.localStart,
          duration_min: spec.durationMin,
        }),
        readyDir,
        index,
        goPath,
      ),
    ),
  );

  // Release nobody until every racer has booted and announced readiness, so the only thing
  // separating their writes is scheduling, not process startup.
  const readyDeadline = Date.now() + RACER_BOOT_TIMEOUT_MS;
  for (;;) {
    let ready = 0;
    for (let id = 0; id < spec.racers; id += 1) {
      if (existsSync(join(readyDir, `ready-${String(id)}`))) ready += 1;
    }
    if (ready === spec.racers) break;
    if (Date.now() > readyDeadline) {
      throw new Error(`${spec.label}: only ${String(ready)} of ${String(spec.racers)} racers became ready`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // The instant the go signal is written. Every racer must fire at or after this, or it
  // slipped the barrier; that is a harness-correctness fact, independent of how fast the
  // machine is, and is not used to infer overlap.
  const releasedAt = Date.now();
  writeFileSync(goPath, '');

  const children = await closing;
  const fired = children.map((child) => child.fired_at);
  // Stray occupancy means a row on a table *nobody asked for*. The policed set is
  // therefore the union of the tables the racers actually requested — not every table
  // that happens to exist. Filtering on knownTables instead would exclude the untouched
  // table from its own assertion, so six bogus rows planted on it would still read zero.
  const requestedTables = [
    ...new Set(Array.from({ length: spec.racers }, (_unused, index) => spec.tablesFor(index)).flat()),
  ];
  const placeholders = requestedTables.map(() => '?').join(', ');
  const observer = openDatabase(dbPath);
  try {
    return {
      label: spec.label,
      localStart: spec.localStart,
      fireAt: releasedAt,
      children,
      created: children.filter((child) => child.status === 201),
      refused: children.filter((child) => child.status === 409),
      fireSpreadMs: Math.max(...fired) - Math.min(...fired),
      distinctPids: new Set(children.map((child) => child.pid)).size,
      occupancyRows: (observer.prepare('SELECT count(*) AS n FROM occupancy').get() as { n: number }).n,
      bookingRows: (observer.prepare('SELECT count(*) AS n FROM booking').get() as { n: number }).n,
      orphanRows: (
        observer
          .prepare('SELECT count(*) AS n FROM occupancy o LEFT JOIN booking b ON b.id = o.booking_id WHERE b.id IS NULL')
          .get() as { n: number }
      ).n,
      strayRows: (
        observer
          .prepare(`SELECT count(*) AS n FROM occupancy WHERE dining_table_id NOT IN (${placeholders})`)
          .get(...requestedTables) as { n: number }
      ).n,
      untouchedRows: (
        observer
          .prepare(
            `SELECT count(*) AS n FROM occupancy WHERE dining_table_id IN (${spec.knownTables
              .map(() => '?')
              .join(', ')}) AND dining_table_id NOT IN (${placeholders})`,
          )
          .get(...spec.knownTables, ...requestedTables) as { n: number }
      ).n,
      winnerIds: [
        ...new Set(
          children
            .filter((child) => child.status === 201)
            .map((child) => child.booking_id as string),
        ),
      ],
      quantaPerWinner: spec.durationMin / 15,
    };
  } finally {
    observer.close();
    rmSync(raceDir, { recursive: true, force: true });
  }
}

function assertGenuineRace(report: RaceReport, racers: number): void {
  assert.equal(
    report.distinctPids,
    racers,
    `${report.label}: every racer must be its own OS process, not a thread`,
  );
  const jumpedTheGun = report.children.filter((child) => child.fired_at < report.fireAt);
  assert.equal(
    jumpedTheGun.length,
    0,
    `${report.label}: ${String(jumpedTheGun.length)} racer(s) fired before the go signal was released`,
  );
  assert.ok(
    report.fireSpreadMs < MAX_FIRE_SPREAD_MS,
    `${report.label}: racers fired over ${report.fireSpreadMs}ms, which is not a race`,
  );
}

test(
  `${RACERS} separate processes racing one slot: exactly one 201 and ${RACERS - 1} 409`,
  async () => {
    // The repetitions run one after another, deliberately. Running them together was a
    // large part of the load that pushed the harness's own timing measurements around; the
    // contention this test needs comes from the twelve racers inside one repetition, not
    // from three repetitions fighting each other for CPU.
    const reports: RaceReport[] = [];
    for (let index = 0; index < REPETITIONS.length; index += 1) {
      reports.push(
        await race({
          label: `race-${String(index)}`,
          racers: RACERS,
          localStart: REPETITIONS[index]!.localStart,
          tablesFor: () => ['table-contested'],
          knownTables: ['table-contested', 'table-untouched'],
          durationMin: 90,
        }),
      );
    }

    for (const report of reports) {
      assertGenuineRace(report, RACERS);

      assert.equal(
        report.created.length,
        1,
        `${report.label}: expected exactly one 201, got ${report.children
          .map((child) => child.status)
          .join(',')}`,
      );
      assert.equal(report.refused.length, RACERS - 1);
      for (const child of report.refused) {
        assert.equal(child.code, 'SLOT_TAKEN');
      }

      // Overlap proven at the database: at least one racer must have actually been bounced
      // on SQLITE_BUSY (contention existed), and at least one must have gone through without
      // a retry (they collided at an instant, they did not queue one behind another).
      const retries = report.children.map((child) => child.busy_retries);
      assert.ok(
        retries.some((count) => count >= 1),
        `${report.label}: no racer observed SQLITE_BUSY, so concurrent writing is not demonstrated`,
      );
      assert.ok(
        retries.some((count) => count === 0),
        `${report.label}: every racer retried, which is a queue rather than a race`,
      );

      const winner = report.children.find((child) => child.status === 201);
      assert.equal(
        winner?.busy_retries,
        0,
        `${report.label}: the winner acquired the write lock first and must not have retried`,
      );

      assert.equal(report.bookingRows, 1, 'exactly one booking row exists');
      assert.equal(
        report.occupancyRows,
        report.quantaPerWinner,
        '90 minutes is 6 quanta — one row per covered quantum, not one row per booking',
      );
      assert.equal(report.orphanRows, 0, 'no occupancy row without its booking');
      assert.equal(report.strayRows, 0, 'no occupancy row landed on a table no racer requested');
      assert.equal(
        report.untouchedRows,
        0,
        'the table that exists but was never requested has no occupancy rows',
      );
      assert.deepEqual(report.winnerIds.length, 1, 'the single winner returned a booking id');

      const mapping = report.children
        .map((child) => `${String(child.status)}/${String(child.busy_retries)}`)
        .join(' ');
      const losersWithoutRetry = report.refused.filter((child) => child.busy_retries === 0).length;
      process.stdout.write(
        `    ${report.label} local start ${report.localStart}` +
          ` -> ${report.created.length} x 201, ${report.refused.length} x 409,` +
          ` ${report.occupancyRows} occupancy rows, fire spread ${report.fireSpreadMs}ms,` +
          ` retries ${JSON.stringify(retries)}, status/retries [${mapping}]` +
          `${losersWithoutRetry > 0 ? `, FINDING: ${String(losersWithoutRetry)} loser(s) never retried` : ''}\n`,
      );
    }
  },
);

test('several processes opening a brand-new file at once all migrate successfully', async () => {
  // Every connection migrates on open, so with no seeder this is the one case where the
  // WAL switch inside openDatabase is genuinely contended. busy_timeout does not make
  // that pragma wait, so without the retry the losers get SQLITE_BUSY out of a connection
  // that has done nothing wrong, and the caller is told the service is busy when the only
  // thing contending was the schema.
  const openDir = join(dir, 'cold-open');
  rmSync(openDir, { recursive: true, force: true });
  mkdirSync(openDir, { recursive: true });
  const dbPath = join(openDir, 'cold.db');

  const readyDir = join(openDir, 'ready');
  mkdirSync(readyDir, { recursive: true });
  const goPath = join(openDir, 'go');

  const openers = 8;
  const children = Array.from({ length: openers }, (_unused, id) =>
    new Promise<{ pid: number; fired_at: number; tables: string[]; error: string | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [openerPath, dbPath, readyDir, String(id), goPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
          reject(new Error(`opener pid ${String(child.pid)} exited ${String(code)}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as { pid: number; fired_at: number; tables: string[]; error: string | null });
      });
    }),
  );

  const readyDeadline = Date.now() + RACER_BOOT_TIMEOUT_MS;
  for (;;) {
    let ready = 0;
    for (let id = 0; id < openers; id += 1) {
      if (existsSync(join(readyDir, `ready-${String(id)}`))) ready += 1;
    }
    if (ready === openers) break;
    if (Date.now() > readyDeadline) {
      throw new Error(`cold-open: only ${String(ready)} of ${String(openers)} openers became ready`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  writeFileSync(goPath, '');

  const results = await Promise.all(children);

  const fired = results.map((result) => result.fired_at);
  assert.ok(
    Math.max(...fired) - Math.min(...fired) < MAX_FIRE_SPREAD_MS,
    `the openers must overlap (spread ${String(Math.max(...fired) - Math.min(...fired))}ms)`,
  );
  const failures = results.filter((result) => result.error !== null);
  assert.deepEqual(
    failures.map((result) => result.error),
    [],
    'no process may fail to open a fresh database because another was migrating',
  );
  const wholeSchema = ['booking', 'dining_table', 'idempotency_key', 'occupancy', 'restaurant', 'schema_migration'];
  for (const result of results) {
    assert.deepEqual(result.tables, wholeSchema, 'every opener sees the whole schema, not a partial one');
  }
  assert.equal(new Set(results.map((result) => result.pid)).size, openers, 'distinct processes');
});

test('the guarantee is in the store: a duplicate (table, quantum) insert is refused outright', () => {
  // The races above can all pass while the guarantee lives in BEGIN IMMEDIATE plus a
  // read-then-write availability check, which serialise writers just as well. That is a
  // correct implementation, but it is not the one this stage mandates, and it collapses
  // the moment a second writer appears that does not go through the booking path. This
  // assertion pins the requirement where the task puts it: the occupancy table itself must
  // refuse a duplicate, with no transaction and no application check involved.
  const probeDir = join(dir, 'probe-store');
  mkdirSync(probeDir, { recursive: true });
  const db = openDatabase(join(probeDir, 'probe.db'));
  try {
    db.prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)').run('r', 'Probe', 'UTC');
    db.prepare('INSERT INTO dining_table (id, restaurant_id, seats) VALUES (?, ?, ?)').run('t', 'r', 4);
    db.prepare('INSERT INTO booking (id, restaurant_id, party_size, start_utc, duration_min, status, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('b1', 'r', 2, '2026-06-15T19:00:00.000Z', 30, 'confirmed', '2026-06-15T00:00:00.000Z');
    db.prepare('INSERT INTO booking (id, restaurant_id, party_size, start_utc, duration_min, status, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('b2', 'r', 2, '2026-06-15T19:00:00.000Z', 30, 'confirmed', '2026-06-15T00:00:00.000Z');

    const insert = db.prepare(
      'INSERT INTO occupancy (dining_table_id, quantum_start_utc, booking_id) VALUES (?, ?, ?)',
    );
    insert.run('t', '2026-06-15T19:00:00.000Z', 'b1');
    assert.throws(
      () => insert.run('t', '2026-06-15T19:00:00.000Z', 'b2'),
      (err: { message: string }) =>
        err.message.startsWith('UNIQUE constraint failed: occupancy.dining_table_id, occupancy.quantum_start_utc'),
      'the occupancy primary key must refuse a duplicate (table, quantum)',
    );
    // And the key is not over-broad: the next quantum on the same table still inserts.
    insert.run('t', '2026-06-15T19:15:00.000Z', 'b2');
    assert.equal((db.prepare('SELECT count(*) AS n FROM occupancy').get() as { n: number }).n, 2);
  } finally {
    db.close();
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test('two processes booking two different tables at the same time both succeed', async () => {
  const report = await race({
    label: 'race-innocent',
    racers: 2,
    localStart: '2026-06-15T19:15',
    tablesFor: (index) => [index === 0 ? 'table-alpha' : 'table-beta'],
    knownTables: ['table-alpha', 'table-beta'],
    durationMin: 90,
  });

  assertGenuineRace(report, 2);
  assert.equal(report.created.length, 2, `both must win, got ${report.children.map((c) => c.status).join(',')}`);
  assert.equal(report.refused.length, 0);
  assert.equal(report.bookingRows, 2);
  assert.equal(report.occupancyRows, 2 * report.quantaPerWinner, 'six quanta on each of the two tables');
  assert.equal(report.orphanRows, 0);
  assert.equal(report.strayRows, 0);
  assert.equal(
    new Set(report.created.map((child) => child.booking_id)).size,
    2,
    'the guarantee rejected no innocent booking: two distinct bookings exist',
  );

  process.stdout.write(
    `    innocent race -> ${report.created.length} x 201, ${report.occupancyRows} occupancy rows, fire spread ${report.fireSpreadMs}ms\n`,
  );
});