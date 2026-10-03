/**
 * Table assignment and the availability endpoint.
 *
 * Two questions are asked here and neither is answered by "it returned something":
 *   - which tables cover a party, and is that answer independent of the order rows come back in;
 *   - does the search offer a slot that the write side would refuse. The exhaustive answer to
 *     that second question is `parity.test.ts`; what is checked here is the shape of the
 *     response, the status codes, and the promise that the search writes nothing.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { openDatabase, type Db } from '../../stage-1/src/db.ts';
import { reserve } from '../../stage-1/src/bookings.ts';
import { resolveLocalStartInstant } from '../../stage-1/src/timezone.ts';
import { isApiError } from '../../stage-1/src/errors.ts';
import { migrate2 } from './hours.ts';
import { createStage2RequestListener, findTableCombination, isSlotBookable } from './availability.ts';

const ZONE = 'America/New_York';
const FRIDAY = '2026-10-02';
const SATURDAY = '2026-10-03';

/** Widest first in arrival order, so a first-fit scan would pick `big`. */
const ASSIGN = 'assign';
/** No tables at all, next to a restaurant whose tables would fit any party. */
const EMPTY = 'assign-empty';
const OTHER = 'assign-other';
const SMALL_TABLES = 'assign-max4';
/** Holds one real booking, made through stage 1's write path. */
const HELD = 'held';
const SEARCH = 'search';
const SEARCH_TAKEN = 'search-taken';
const SEARCH_DST = 'search-dst';

let dir: string;
let db: Db;
let server: Server;
let base: string;

type Slot = { start_utc: string; start_local: string; table_ids: string[] };
type Call = { status: number; body: Record<string, unknown> };

function utc(localDate: string, localTime: string): string {
  return resolveLocalStartInstant(`${localDate}T${localTime}`, ZONE);
}

function assign(db2: Db, restaurantId: string, partySize: number, startUtc: string, durationMin: number) {
  return findTableCombination(db2, restaurantId, partySize, startUtc, durationMin);
}

async function call(method: string, path: string, body?: unknown): Promise<Call> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) };
}

function errorCode(result: Call): string {
  return (result.body.error as { code?: string } | undefined)?.code ?? '<missing>';
}

async function slots(localDate: string, partySize: number, durationMin: number, restaurantId = SEARCH): Promise<Slot[]> {
  const result = await call(
    'GET',
    `/v1/restaurants/${restaurantId}/availability?local_date=${localDate}&party_size=${partySize}&duration_min=${durationMin}`,
  );
  assert.equal(result.status, 200);
  return (result.body as { slots: Slot[] }).slots;
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-availability-'));
  db = openDatabase(join(dir, 'stage2.db'));
  migrate2(db);

  const insertRestaurant = db.prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)');
  for (const id of [ASSIGN, EMPTY, OTHER, SMALL_TABLES, HELD, SEARCH, SEARCH_TAKEN, SEARCH_DST]) {
    insertRestaurant.run(id, id, ZONE);
  }

  const insertTable = db.prepare('INSERT INTO dining_table (id, restaurant_id, seats) VALUES (?, ?, ?)');
  insertTable.run('big', ASSIGN, 8);
  insertTable.run('mid', ASSIGN, 4);
  insertTable.run('small', ASSIGN, 2);
  insertTable.run('other-12', OTHER, 12);
  insertTable.run('only-4a', SMALL_TABLES, 4);
  insertTable.run('only-4b', SMALL_TABLES, 4);
  insertTable.run('held-8', HELD, 8);
  insertTable.run('held-2', HELD, 2);
  insertTable.run('s-4', SEARCH, 4);
  insertTable.run('s-2', SEARCH, 2);
  insertTable.run('taken-4', SEARCH_TAKEN, 4);
  insertTable.run('dst-4', SEARCH_DST, 4);

  const insertHours = db.prepare(
    'INSERT INTO restaurant_hours (restaurant_id, weekday, opens_min, closes_min) VALUES (?, ?, ?, ?)',
  );
  for (const id of [ASSIGN, EMPTY, OTHER, SMALL_TABLES, HELD]) {
    for (let weekday = 0; weekday <= 6; weekday += 1) insertHours.run(id, weekday, 11 * 60, 23 * 60);
  }
  for (let weekday = 1; weekday <= 5; weekday += 1) insertHours.run(SEARCH, weekday, 11 * 60, 22 * 60);
  for (let weekday = 1; weekday <= 5; weekday += 1) insertHours.run(SEARCH_TAKEN, weekday, 11 * 60, 22 * 60);
  // Open every hour of Sunday, which is what the two DST Sundays need.
  insertHours.run(SEARCH_DST, 0, 0, 24 * 60);

  // Two real bookings, both made through stage 1's write path, so the occupancy they hold is
  // the occupancy the search reads.
  reserve(db, {
    restaurantId: HELD,
    tableIds: ['held-8'],
    partySize: 8,
    localStart: `${FRIDAY}T19:00`,
    durationMin: 45,
  });
  reserve(db, {
    restaurantId: SEARCH_TAKEN,
    tableIds: ['taken-4'],
    partySize: 4,
    localStart: `${FRIDAY}T12:00`,
    durationMin: 45,
  });

  server = createServer(createStage2RequestListener(db));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string', 'the test server bound a TCP port');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a party is assigned the tightest table that can seat it', () => {
  const startUtc = utc(FRIDAY, '19:00');
  assert.deepEqual(assign(db, ASSIGN, 2, startUtc, 60), { tableIds: ['small'], seats: 2 });
  assert.deepEqual(assign(db, ASSIGN, 4, startUtc, 60), { tableIds: ['mid'], seats: 4 });
  assert.deepEqual(assign(db, ASSIGN, 8, startUtc, 60), { tableIds: ['big'], seats: 8 });
});

test('a first-fit scan would be wrong: the tightest workable table wins, whatever the row order', () => {
  const arrivalOrder = db
    .prepare('SELECT id, seats FROM dining_table WHERE restaurant_id = ?')
    .all(ASSIGN) as { id: string; seats: number }[];
  assert.deepEqual(
    arrivalOrder.map((row) => row.id),
    ['big', 'mid', 'small'],
    'inserted widest first, so a scan would reach big before mid',
  );
  assert.equal(arrivalOrder.find((row) => row.seats >= 4)?.id, 'big', 'first fit would take the eight-seat table');

  assert.deepEqual(assign(db, ASSIGN, 4, utc(FRIDAY, '19:00'), 60)?.tableIds, ['mid']);
});

test('another restaurant\'s tables are never returned, even when they would fit', () => {
  const startUtc = utc(FRIDAY, '19:00');
  const own = db
    .prepare('SELECT id FROM dining_table WHERE restaurant_id = ?')
    .all(ASSIGN) as { id: string }[];
  const ownIds = own.map((row) => row.id);

  const combination = assign(db, ASSIGN, 8, startUtc, 60);
  assert.deepEqual(combination?.tableIds, ['big']);
  for (const tableId of combination?.tableIds ?? []) {
    assert.ok(ownIds.includes(tableId), `${tableId} does not belong to ${ASSIGN}`);
  }

  // A restaurant with no tables at all must report absence, not borrow the neighbour's twelve.
  assert.equal(assign(db, EMPTY, 2, startUtc, 60), null);
  assert.equal(isSlotBookable(db, EMPTY, ['other-12'], startUtc, 60), false);
  assert.equal(isSlotBookable(db, ASSIGN, ['other-12'], startUtc, 60), false);
});

test('a party larger than any table reports absence rather than throwing', () => {
  assert.equal(assign(db, ASSIGN, 9, utc(FRIDAY, '19:00'), 60), null);
  assert.equal(assign(db, SMALL_TABLES, 5, utc(FRIDAY, '19:00'), 60), null);
});

test('a party of six with only four-seat tables is absence, because the write path refuses it', () => {
  // Stage 1 refuses a request whose party_size exceeds the seats of any table it was given
  // (stage-1/src/bookings.ts, the TABLE_TOO_SMALL branch). Summing seats across a set would let
  // this search offer {only-4a, only-4b} for a party of six and the write path would answer
  // TABLE_TOO_SMALL — an offered slot that is then refused, the one defect this stage exists to
  // prevent. So the search reports nothing, and this asserts the refusal is real rather than
  // asserting it in prose.
  assert.equal(assign(db, SMALL_TABLES, 6, utc(FRIDAY, '19:00'), 60), null);

  let refusal: string | null = null;
  try {
    reserve(db, {
      restaurantId: SMALL_TABLES,
      tableIds: ['only-4a', 'only-4b'],
      partySize: 6,
      localStart: `${FRIDAY}T19:00`,
      durationMin: 60,
    });
  } catch (err) {
    assert.ok(isApiError(err), `expected an ApiError, got ${String(err)}`);
    refusal = err.code;
  }
  assert.equal(refusal, 'TABLE_TOO_SMALL');
});

test('a table held for a partial overlap is excluded across the whole overlapping range', () => {
  // held-8 is booked 19:00-19:45 local, which is three quanta: 19:00, 19:15 and 19:30.
  assert.equal(isSlotBookable(db, HELD, ['held-8'], utc(FRIDAY, '19:00'), 15), false);
  assert.equal(isSlotBookable(db, HELD, ['held-8'], utc(FRIDAY, '19:15'), 15), false);
  assert.equal(isSlotBookable(db, HELD, ['held-8'], utc(FRIDAY, '19:30'), 15), false, 'the third quantum too');
  assert.equal(isSlotBookable(db, HELD, ['held-8'], utc(FRIDAY, '19:00'), 30), false, 'a span inside the hold');

  // The quanta either side are free: 18:45-19:00 abuts the hold and 19:45 is the first one after.
  assert.equal(isSlotBookable(db, HELD, ['held-8'], utc(FRIDAY, '18:45'), 15), true);
  assert.equal(isSlotBookable(db, HELD, ['held-8'], utc(FRIDAY, '19:45'), 15), true);

  // And the assignment follows: a party of eight has only held-8 to sit at, so the 19:30 start
  // is absent rather than answered with the held table.
  assert.equal(assign(db, HELD, 8, utc(FRIDAY, '19:30'), 15), null);
  assert.deepEqual(assign(db, HELD, 2, utc(FRIDAY, '19:30'), 15)?.tableIds, ['held-2']);
  assert.deepEqual(assign(db, HELD, 8, utc(FRIDAY, '19:45'), 15)?.tableIds, ['held-8']);
});

test('GET /v1/restaurants/:id/availability returns slot starts in the restaurant\'s zone', async () => {
  const found = await slots(FRIDAY, 2, 60);
  // Open 11:00, close 22:00, a 60-minute booking: the last start that fits is 21:00, and
  // 11:00 through 21:00 at a 15-minute quantum is 41 starts.
  assert.equal(found.length, 41);
  assert.deepEqual(found[0], { start_utc: '2026-10-02T15:00:00.000Z', start_local: `${FRIDAY}T11:00`, table_ids: ['s-2'] });
  assert.deepEqual(found[found.length - 1], {
    start_utc: '2026-10-03T01:00:00.000Z',
    start_local: `${FRIDAY}T21:00`,
    table_ids: ['s-2'],
  });

  const ordered = found.map((slot) => slot.start_utc);
  assert.deepEqual(ordered, [...ordered].sort(), 'slots are ordered by start_utc');

  const ownIds = new Set(
    (db.prepare('SELECT id FROM dining_table WHERE restaurant_id = ?').all(SEARCH) as { id: string }[]).map(
      (row) => row.id,
    ),
  );
  for (const slot of found) {
    assert.ok(slot.table_ids.length > 0, 'every offered slot names the tables it would book');
    for (const tableId of slot.table_ids) assert.ok(ownIds.has(tableId), `${tableId} is not this restaurant's`);
    assert.equal(
      resolveLocalStartInstant(slot.start_local, ZONE, 0),
      slot.start_utc,
      'start_local must be the restaurant-local reading of start_utc',
    );
  }

  // A party of four gets the four-seat table, and a party of two the two-seat one.
  assert.deepEqual((await slots(FRIDAY, 4, 60))[0]?.table_ids, ['s-4']);
  assert.deepEqual((await slots(FRIDAY, 2, 60))[0]?.table_ids, ['s-2']);
});

test('a booked slot is absent from the results and its neighbours are present', async () => {
  const found = (await slots(FRIDAY, 4, 45, SEARCH_TAKEN)).map((slot) => slot.start_local);
  // taken-4 is the only table and it is held 12:00-12:45. A 45-minute request is three quanta
  // wide, so the four starts that would run into the hold are all absent -- including 11:45,
  // which begins before it. A search that only dropped the starts it had seen rows for would
  // offer 11:45.
  for (const blocked of ['11:30', '11:45', '12:00', '12:15', '12:30']) {
    assert.equal(found.includes(`${FRIDAY}T${blocked}`), false, `${blocked} runs into the hold`);
  }
  assert.equal(found.includes(`${FRIDAY}T11:15`), true, 'the start before the hold is offered');
  assert.equal(found.includes(`${FRIDAY}T13:00`), true, 'the first start clear of it is offered');
  assert.equal(found.length, 37, '42 starts from 11:00 to 21:15, less the 5 that touch the hold');
});

test('the search writes nothing', async () => {
  const before = {
    occupancy: countRows('occupancy'),
    booking: countRows('booking'),
    idempotency: countRows('idempotency_key'),
    hours: countRows('restaurant_hours'),
  };
  const found = await slots(FRIDAY, 4, 60);
  const foundTaken = await slots(FRIDAY, 4, 45, SEARCH_TAKEN);
  const foundDst = await slots('2026-11-01', 2, 60, SEARCH_DST);
  assert.ok(found.length > 0 && foundTaken.length > 0 && foundDst.length > 0, 'the searches actually answered');

  assert.deepEqual(
    {
      occupancy: countRows('occupancy'),
      booking: countRows('booking'),
      idempotency: countRows('idempotency_key'),
      hours: countRows('restaurant_hours'),
    },
    before,
    'a search holds nothing, reserves nothing, and records no key',
  );
});

test('a closed weekday answers with an empty list, not a refusal', async () => {
  // SEARCH is configured Monday to Friday only.
  assert.deepEqual(await slots(SATURDAY, 2, 60), []);
  assert.deepEqual(await slots(FRIDAY, 2, 60).then((found) => found.length > 0), true);
});

test('an unknown restaurant is 404 and a bad query is 400, using stage 1\'s codes', async () => {
  const unknown = await call('GET', '/v1/restaurants/no-such-restaurant/availability?local_date=2026-10-02&party_size=2&duration_min=60');
  assert.equal(unknown.status, 404);
  assert.equal(errorCode(unknown), 'NOT_FOUND');

  const path = '/v1/restaurants/assign/availability?local_date=2026-10-02';
  const zeroParty = await call('GET', `${path}&party_size=0&duration_min=60`);
  assert.equal(zeroParty.status, 400);
  assert.equal(errorCode(zeroParty), 'INVALID_PARTY_SIZE');

  const missingParty = await call('GET', `${path}&duration_min=60`);
  assert.equal(missingParty.status, 400);
  assert.equal(errorCode(missingParty), 'INVALID_PARTY_SIZE');

  const offGrid = await call('GET', `${path}&party_size=2&duration_min=20`);
  assert.equal(offGrid.status, 400);
  assert.equal(errorCode(offGrid), 'INVALID_DURATION');

  const missingDuration = await call('GET', `${path}&party_size=2`);
  assert.equal(missingDuration.status, 400);
  assert.equal(errorCode(missingDuration), 'INVALID_DURATION');

  const missingDate = await call('GET', `/v1/restaurants/assign/availability?party_size=2&duration_min=60`);
  assert.equal(missingDate.status, 400);
  assert.equal(errorCode(missingDate), 'INVALID_TIME');

  const impossibleDate = await call('GET', `${path.replace('2026-10-02', '2026-02-30')}&party_size=2&duration_min=60`);
  assert.equal(impossibleDate.status, 400);
  assert.equal(errorCode(impossibleDate), 'INVALID_TIME');

  const nestedPath = await call('GET', '/v1/restaurants/assign/tables/s-4/availability?local_date=2026-10-02&party_size=2&duration_min=60');
  assert.equal(nestedPath.status, 404);
  assert.equal(errorCode(nestedPath), 'NOT_FOUND');
});

test('stage 1 routes and status codes are unchanged behind this listener', async () => {
  assert.deepEqual((await call('GET', '/health')).body, { status: 'ok' });

  const wrongMethod = await call('POST', '/v1/restaurants/assign/availability?local_date=2026-10-02&party_size=2&duration_min=60');
  assert.equal(wrongMethod.status, 404);
  assert.equal(errorCode(wrongMethod), 'NOT_FOUND');

  const restaurant = await call('POST', '/v1/restaurants', { name: 'Latecomer', timezone: 'Europe/London' });
  assert.equal(restaurant.status, 201);
  const restaurantId = (restaurant.body as { id: string }).id;

  const table = await call('POST', `/v1/restaurants/${restaurantId}/tables`, { seats: 4 });
  assert.equal(table.status, 201);

  const booking = await call('POST', '/v1/bookings', {
    restaurant_id: restaurantId,
    table_ids: [(table.body as { id: string }).id],
    party_size: 2,
    local_start: '2026-10-02T19:00',
    duration_min: 60,
  });
  assert.equal(booking.status, 201);
  const bookingId = (booking.body as { id: string }).id;

  assert.equal((await call('GET', `/v1/bookings/${bookingId}`)).status, 200);
  assert.equal((await call('DELETE', `/v1/bookings/${bookingId}`)).status, 204);
  assert.equal((await call('GET', '/v1/restaurants')).status, 404);
});

test('a fall-back day offers both copies of the repeated hour', async () => {
  const found = await slots('2026-11-01', 2, 60, SEARCH_DST);
  const repeated = found.filter((slot) => slot.start_local === '2026-11-01T01:30');
  assert.deepEqual(
    repeated.map((slot) => slot.start_utc),
    ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
    'both instants of the repeated wall hour are real and both are offered',
  );
  const ordered = found.map((slot) => slot.start_utc);
  assert.deepEqual(ordered, [...ordered].sort(), 'still ordered by start_utc');
  // 93 grid starts from 00:00 to 23:00, and the four that repeat (01:00 to 01:45) are offered
  // at both of their instants, so the day is 97 slots rather than 93.
  assert.equal(found.length, 97);
  assert.deepEqual(
    ['01:00', '01:15', '01:30', '01:45'].map((hhmm) =>
      found.filter((slot) => slot.start_local === `2026-11-01T${hhmm}`).length,
    ),
    [2, 2, 2, 2],
    'every repeated wall time is offered twice',
  );
  assert.equal(found.filter((slot) => slot.start_local === '2026-11-01T02:00').length, 1);
});

test('a spring-forward gap is never offered', async () => {
  // 02:00 to 02:59 on 2026-03-08 does not exist in America/New_York. The local grid walks it
  // anyway and the resolver returns no candidate for those four starts, so no slot can carry
  // that wall time: 93 grid starts, less the 4 in the gap, is 89.
  const found = await slots('2026-03-08', 2, 60, SEARCH_DST);
  assert.equal(
    found.some((slot) => slot.start_local.startsWith('2026-03-08T02:')),
    false,
    'the gap is not a bookable wall time',
  );
  assert.deepEqual(
    found.filter((slot) => slot.start_local === '2026-03-08T01:30').map((slot) => slot.start_utc),
    ['2026-03-08T06:30:00.000Z'],
    'the last start before the gap is still EST, UTC-5',
  );
  assert.deepEqual(
    found.filter((slot) => slot.start_local === '2026-03-08T03:00').map((slot) => slot.start_utc),
    ['2026-03-08T07:00:00.000Z'],
    'the first start after the gap is EDT, UTC-4, so an hour of the day is skipped in UTC',
  );
  assert.equal(found.length, 89);
});