/**
 * Hours of operation: the service window, its boundaries, and the wall clock it is measured on.
 *
 * Every assertion names a weekday and a minute-of-day read in the restaurant's own zone. A test
 * that only checked "it threw" would also pass under a resolver that read the host's clock, and
 * that is the mistake this file exists to catch.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../stage-1/src/db.ts';
import { findLocalStartCandidates, resolveLocalStartInstant } from '../../stage-1/src/timezone.ts';
import { isApiError } from '../../stage-1/src/errors.ts';
import { assertWithinHours, getHours, migrate2, zonePosition } from './hours.ts';

const NEW_YORK = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

/** Open Monday to Friday 11:00-23:00, so Saturday and Sunday are both closed weekdays. */
const WEEKDAY = 'hours-weekday';
const FRIDAY = '2026-10-02';
const SATURDAY_UTC = '2026-10-03T14:00:00.000Z';
const SUNDAY_UTC = '2026-10-04T14:00:00.000Z';
/** No rows at all: every weekday reads as closed. */
const UNCONFIGURED = 'hours-unconfigured';
/** Closes at midnight on every weekday, which is `closes_min = 1440`. */
const MIDNIGHT = 'hours-midnight';
const DST_SUNDAY = '2026-11-01';
/** One copy of 01:30 on this Sunday is inside 01:00-02:00; the other is not, because a real
 *  hour later the clock has already left the repeated hour. */
const DST_REPEAT = 'hours-dst-repeat';
const SPRING_SUNDAY = '2026-03-08';
/** Closes at 04:00 local, which is one wall-clock hour before the instant this Sunday's
 * 01:30 booking actually ends. */
const DST_SPRING = 'hours-dst-spring';
/** Open Monday to Friday 10:00-23:00 in Tokyo; closed on Saturday and Sunday. */
const TOKYO_RESTAURANT = 'hours-tokyo';

let dir: string;
let db: Db;

/** Assert the booking is accepted. A throw here is the failure. */
function accepted(restaurantId: string, startUtc: string, durationMin: number): void {
  assertWithinHours(db, restaurantId, startUtc, durationMin);
}

/** Assert the booking is refused, and return the refusal so its code and details can be read. */
function refusal(
  restaurantId: string,
  startUtc: string,
  durationMin: number,
): { code: string; details: Record<string, unknown> } {
  try {
    assertWithinHours(db, restaurantId, startUtc, durationMin);
  } catch (err) {
    assert.ok(isApiError(err), `expected an ApiError, got ${String(err)}`);
    return { code: err.code, details: err.details };
  }
  assert.fail(`assertWithinHours accepted a booking it must refuse: ${restaurantId} ${startUtc} ${durationMin}`);
}

function utc(localDate: string, localTime: string, zone: string): string {
  return resolveLocalStartInstant(`${localDate}T${localTime}`, zone);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-hours-'));
  db = openDatabase(join(dir, 'stage2.db'));
  migrate2(db);

  const insertRestaurant = db.prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)');
  insertRestaurant.run(WEEKDAY, 'Hours weekday', NEW_YORK);
  insertRestaurant.run(UNCONFIGURED, 'Hours unconfigured', NEW_YORK);
  insertRestaurant.run(MIDNIGHT, 'Hours midnight', NEW_YORK);
  insertRestaurant.run(DST_REPEAT, 'Hours DST repeat', NEW_YORK);
  insertRestaurant.run(DST_SPRING, 'Hours DST spring', NEW_YORK);
  insertRestaurant.run(TOKYO_RESTAURANT, 'Hours Tokyo', TOKYO);

  const insertHours = db.prepare(
    'INSERT INTO restaurant_hours (restaurant_id, weekday, opens_min, closes_min) VALUES (?, ?, ?, ?)',
  );
  for (let weekday = 1; weekday <= 5; weekday += 1) insertHours.run(WEEKDAY, weekday, 11 * 60, 23 * 60);
  for (let weekday = 0; weekday <= 6; weekday += 1) insertHours.run(MIDNIGHT, weekday, 0, 24 * 60);
  insertHours.run(DST_REPEAT, 0, 60, 120);
  insertHours.run(DST_SPRING, 0, 60, 240);
  for (let weekday = 1; weekday <= 5; weekday += 1) insertHours.run(TOKYO_RESTAURANT, weekday, 10 * 60, 23 * 60);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('migrate2 is idempotent and records its row in stage 1\'s ledger, not a second one', () => {
  const readLedger = (): { name: string }[] =>
    db.prepare('SELECT name FROM schema_migration ORDER BY name').all() as { name: string }[];
  const first = readLedger();
  migrate2(db);
  migrate2(db);
  assert.deepEqual(readLedger(), first, 're-running migrate2 must not add a second ledger row');
  assert.ok(first.some((row) => row.name === '0002_restaurant_hours'), 'stage 2 records its migration');

  const ledgers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%migration%'")
    .all() as { name: string }[];
  assert.deepEqual(ledgers.map((row) => row.name), ['schema_migration'], 'there is exactly one migration ledger');
});

test('getHours returns the configured window, and null when the weekday has no row', () => {
  assert.deepEqual(getHours(db, WEEKDAY, 5), { opens: 660, closes: 1380 });
  assert.equal(getHours(db, WEEKDAY, 6), null);
  assert.equal(getHours(db, UNCONFIGURED, 5), null);
  assert.equal(getHours(db, TOKYO_RESTAURANT, 0), null);
  assert.equal(getHours(db, 'no-such-restaurant', 5), null);
});

test('a slot inside service hours is accepted', () => {
  const startUtc = utc(FRIDAY, '19:00', NEW_YORK);
  assert.deepEqual(zonePosition(startUtc, NEW_YORK), { weekday: 5, minutes: 1140, date: FRIDAY });
  accepted(WEEKDAY, startUtc, 60);
});

test('a slot starting one minute before opening is refused', () => {
  const startUtc = utc(FRIDAY, '10:59', NEW_YORK);
  assert.equal(zonePosition(startUtc, NEW_YORK).minutes, 659);
  const refused = refusal(WEEKDAY, startUtc, 60);
  assert.equal(refused.code, 'INVALID_TIME');
  assert.equal(refused.details.local_start_minutes, 659);
  assert.equal(refused.details.opens_minutes, 660);
});

test('a slot ending one minute after closing is refused', () => {
  const refused = refusal(WEEKDAY, utc(FRIDAY, '22:00', NEW_YORK), 90);
  assert.equal(refused.code, 'INVALID_TIME');
  assert.equal(refused.details.local_end_minutes, 1410);
  assert.equal(refused.details.closes_minutes, 1380);
});

test('a booking ending exactly at closing is accepted', () => {
  accepted(WEEKDAY, utc(FRIDAY, '22:00', NEW_YORK), 60);
});

test('a closed weekday is refused, and so is a restaurant with no hours configured', () => {
  const saturday = zonePosition(SATURDAY_UTC, NEW_YORK);
  assert.deepEqual(saturday, { weekday: 6, minutes: 600, date: '2026-10-03' });
  const closedSaturday = refusal(WEEKDAY, SATURDAY_UTC, 60);
  assert.equal(closedSaturday.code, 'INVALID_TIME');
  assert.equal(closedSaturday.details.weekday, 6);

  const sunday = zonePosition(SUNDAY_UTC, NEW_YORK);
  assert.deepEqual(sunday, { weekday: 0, minutes: 600, date: '2026-10-04' });
  const closedSunday = refusal(WEEKDAY, SUNDAY_UTC, 60);
  assert.equal(closedSunday.code, 'INVALID_TIME');
  assert.equal(closedSunday.details.weekday, 0);

  // Fail-closed: no row anywhere means closed, not open.
  const unconfigured = refusal(UNCONFIGURED, utc(FRIDAY, '19:00', NEW_YORK), 60);
  assert.equal(unconfigured.code, 'INVALID_TIME');
  assert.equal(unconfigured.details.weekday, 5);
});

test('an unknown restaurant is NOT_FOUND, not an empty window', () => {
  assert.equal(refusal('no-such-restaurant', utc(FRIDAY, '19:00', NEW_YORK), 60).code, 'NOT_FOUND');
});

test('the same UTC instant is open in one zone and closed in the other, 13 hours apart', () => {
  const tokyoNight = '2026-10-02T23:00:00.000Z';
  assert.deepEqual(zonePosition(tokyoNight, TOKYO), { weekday: 6, minutes: 480, date: '2026-10-03' });
  assert.deepEqual(zonePosition(tokyoNight, NEW_YORK), { weekday: 5, minutes: 1140, date: '2026-10-02' });
  // Tokyo reads it as Saturday 08:00 and does not open on Saturday; New York reads it as
  // Friday 19:00, mid-service. One instant, two answers, and the host's zone is not either.
  assert.equal(refusal(TOKYO_RESTAURANT, tokyoNight, 60).code, 'INVALID_TIME');
  accepted(WEEKDAY, tokyoNight, 60);

  // The same disagreement in the other direction: Tokyo is still serving at 22:00 on Friday,
  // two hours before New York opens.
  const tokyoLate = '2026-10-02T13:00:00.000Z';
  assert.deepEqual(zonePosition(tokyoLate, TOKYO), { weekday: 5, minutes: 1320, date: '2026-10-02' });
  assert.deepEqual(zonePosition(tokyoLate, NEW_YORK), { weekday: 5, minutes: 540, date: '2026-10-02' });
  accepted(TOKYO_RESTAURANT, tokyoLate, 60);
  const tooEarly = refusal(WEEKDAY, tokyoLate, 60);
  assert.equal(tooEarly.code, 'INVALID_TIME');
  assert.equal(tooEarly.details.local_start_minutes, 540);
});

test('a DST transition day where the wall clock repeats reads the same on both copies', () => {
  const first = resolveLocalStartInstant(`${DST_SUNDAY}T01:30`, NEW_YORK, 0);
  const second = resolveLocalStartInstant(`${DST_SUNDAY}T01:30`, NEW_YORK, 1);
  assert.equal(first, '2026-11-01T05:30:00.000Z');
  assert.equal(second, '2026-11-01T06:30:00.000Z');
  assert.equal(Date.parse(second) - Date.parse(first), 3_600_000, 'an hour apart in real time');
  assert.equal(findLocalStartCandidates(`${DST_SUNDAY}T01:30`, NEW_YORK).length, 2);

  // Both copies are 01:30 on Sunday, so the same window applies to both.
  for (const [label, instant] of [
    ['first copy', first],
    ['second copy', second],
  ] as const) {
    assert.deepEqual(zonePosition(instant, NEW_YORK), { weekday: 0, minutes: 90, date: DST_SUNDAY }, label);
    accepted(DST_REPEAT, instant, 30);
  }

  // A 60-minute booking is the honest test on a repeated hour: from the first copy it ends at
  // 01:30 local an hour later, inside the window; from the second it ends at 02:30 local, after
  // it. Both are the same wall-clock start and the same real duration.
  accepted(DST_REPEAT, first, 60);
  const pastClose = refusal(DST_REPEAT, second, 60);
  assert.equal(pastClose.code, 'INVALID_TIME');
  assert.equal(pastClose.details.local_end_minutes, 150);
  assert.equal(pastClose.details.closes_minutes, 120);
});

test('a spring-forward day measures the real end, not the wall-clock end', () => {
  // 01:30 EST plus 120 real minutes is 04:30 EDT — three wall-clock hours later. Closing at
  // 04:00 means the booking's real end is outside service even though its start is inside and a
  // wall-clock sum (90 + 120 = 210) would have landed inside too.
  const startUtc = utc(SPRING_SUNDAY, '01:30', NEW_YORK);
  assert.equal(startUtc, '2026-03-08T06:30:00.000Z');
  assert.deepEqual(zonePosition(startUtc, NEW_YORK), { weekday: 0, minutes: 90, date: SPRING_SUNDAY });
  assert.deepEqual(zonePosition('2026-03-08T08:30:00.000Z', NEW_YORK), {
    weekday: 0,
    minutes: 270,
    date: SPRING_SUNDAY,
  });

  const refused = refusal(DST_SPRING, startUtc, 120);
  assert.equal(refused.code, 'INVALID_TIME');
  assert.equal(refused.details.local_end_minutes, 270);
  assert.equal(refused.details.closes_minutes, 240);
  accepted(DST_SPRING, startUtc, 60);
});

test('closes_min 1440 means closing at midnight, and one minute later is out of scope', () => {
  assert.deepEqual(getHours(db, MIDNIGHT, 0), { opens: 0, closes: 1440 });
  // 22:00 local plus 120 real minutes is exactly 00:00 the next local day, which is the close.
  accepted(MIDNIGHT, utc(DST_SUNDAY, '22:00', NEW_YORK), 120);

  // One minute more ends at 00:01 on the next local day: a past-midnight closing, which this
  // stage refuses rather than half-modelling.
  const refused = refusal(MIDNIGHT, utc(DST_SUNDAY, '22:00', NEW_YORK), 135);
  assert.equal(refused.code, 'INVALID_TIME');
  assert.equal(refused.details.local_start_date, DST_SUNDAY);
  assert.equal(refused.details.local_end_date, '2026-11-02');
});

test('an off-grid instant and a malformed duration are refused by the write path\'s own rules', () => {
  assert.equal(refusal(WEEKDAY, utc(FRIDAY, '19:00', NEW_YORK), 20).code, 'INVALID_DURATION');
  assert.equal(refusal(WEEKDAY, utc(FRIDAY, '19:00', NEW_YORK), 0).code, 'INVALID_DURATION');
  assert.equal(refusal(WEEKDAY, '2026-10-02T19:00', 60).code, 'INVALID_TIME');
  assert.equal(refusal(WEEKDAY, 'not-a-time', 60).code, 'INVALID_TIME');
});