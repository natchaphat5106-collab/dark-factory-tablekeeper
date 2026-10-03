/**
 * The point of this stage: a slot the search offers is a slot the write side accepts.
 *
 * The invariant is one-directional, and only one direction is a defect:
 *
 *   isSlotBookable === true   =>  reserve() must succeed
 *   isSlotBookable === false  =>  reserve() must fail with SLOT_TAKEN, INVALID_TABLE or
 *                                 TABLE_TOO_SMALL. It may legitimately succeed anyway, because
 *                                 a slot can be taken a millisecond after a read and the write
 *                                 side answers that correctly; a stale read is not a defect.
 *
 * Both passes below run inside this one test, over an enumerated grid rather than a
 * hand-written case list: table sets x party sizes x durations x start quanta. A hand-written
 * list tests the cases somebody thought of.
 *
 *   pass 1 asks `isSlotBookable` with the signature TASK.md §4 fixes. That signature carries
 *          no party size, so its party sizes are drawn from the capacity of the table set
 *          under test. This is the predicate the stage publishes.
 *   pass 2 asks the composed predicate the service actually serves — `findTableCombination`
 *          over the full party-size range — because that is the answer `GET /availability`
 *          returns, and it is where multi-table sets and TABLE_TOO_SMALL get parity-checked.
 *
 * Every grid case is executed for real and then undone with stage 1's own `cancelBooking`, so
 * each case is measured against the same fixture inventory. The residue is asserted at the end
 * rather than assumed: the only occupancy left must be the fixture's.
 *
 * The `false ⇒ write refuses` half of the invariant is asserted here, which is only meaningful
 * because this grid lies wholly inside service hours. Outside hours the search is deliberately
 * stricter than the write path — stage 1's `reserve()` has no hours check at all — and there a
 * search refusal beside a write success is the documented one-directional case.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../stage-1/src/db.ts';
import { cancelBooking, reserve, type ReserveRequest } from '../../stage-1/src/bookings.ts';
import { resolveLocalStartInstant } from '../../stage-1/src/timezone.ts';
import { isApiError } from '../../stage-1/src/errors.ts';
import { migrate2 } from './hours.ts';
import { findTableCombination, isSlotBookable } from './availability.ts';

const RESTAURANT_A = 'rest-a';
const RESTAURANT_B = 'rest-b';
const ZONE_A = 'America/New_York';
const LOCAL_DAY = '2026-10-02';

const OWN_TABLES: ReadonlyArray<readonly [string, number]> = [
  ['a-2', 2],
  ['a-4x', 4],
  ['a-4y', 4],
  ['a-6', 6],
  ['a-8', 8],
];
const FOREIGN_TABLE = 'b-12';

/** Every table set under test, including sets the restaurant does not own. */
const TABLE_SETS: ReadonlyArray<readonly string[]> = [
  ['a-2'],
  ['a-4x'],
  ['a-4y'],
  ['a-6'],
  ['a-8'],
  ['a-2', 'a-4x'],
  ['a-4x', 'a-4y'],
  ['a-6', 'a-4x'],
  ['a-2', 'a-8'],
  [FOREIGN_TABLE],
  ['a-4x', FOREIGN_TABLE],
  [FOREIGN_TABLE, 'b-2'],
  ['table-that-does-not-exist'],
];

const PARTY_SIZES = [1, 2, 4, 6, 9];
const DURATIONS = [15, 30, 45, 60];
/** Deliberately straddles the fixture bookings at 19:00, 19:30 and 20:00. */
const START_LOCALS = ['18:30', '19:00', '19:15', '19:30', '20:00'];

/** The only refusals the write path may answer a search refusal with. */
const ALLOWED_REFUSALS = new Set(['SLOT_TAKEN', 'INVALID_TABLE', 'TABLE_TOO_SMALL']);

type Attempt = { ok: boolean; code: string | null };

let dir: string;
let db: Db;
let startUtcByLocal: Map<string, string> = new Map();

function ownTableSeats(): Map<string, number> {
  return new Map(OWN_TABLES);
}

/**
 * The single table a probe booking should use when the search found nothing: the tightest
 * table that could seat the party, or the largest table when none can. Probing with that one
 * table makes the refusal attributable — TABLE_TOO_SMALL when the party cannot be seated at
 * all, SLOT_TAKEN when every table that could seat it is held.
 */
function probeTableId(partySize: number): string {
  const sorted = [...OWN_TABLES].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  const fitting = sorted.find(([, seats]) => seats >= partySize);
  return (fitting ?? sorted[sorted.length - 1] as readonly [string, number])[0];
}

/** Reserve for real, then undo it, so the next grid case sees the fixture again. */
function attemptReserve(request: ReserveRequest): Attempt {
  try {
    const result = reserve(db, request);
    cancelBooking(db, result.booking.id);
    return { ok: true, code: null };
  } catch (err) {
    if (isApiError(err)) return { ok: false, code: err.code };
    throw err;
  }
}

function caseLabel(parts: {
  tableIds: readonly string[];
  partySize: number;
  durationMin: number;
  localStart: string;
  bookable: boolean;
  attempt: Attempt;
  prefix?: string;
}): string {
  return (
    `table_ids=[${parts.tableIds.join(',')}] party_size=${parts.partySize} ` +
    `duration_min=${parts.durationMin} local_start=${parts.localStart} ` +
    `bookable=${parts.bookable} write=${parts.attempt.ok ? 'accepted' : parts.attempt.code}` +
    (parts.prefix === undefined ? '' : ` [${parts.prefix}]`)
  );
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-parity-'));
  db = openDatabase(join(dir, 'stage2.db'));
  migrate2(db);

  db.prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)').run(
    RESTAURANT_A,
    'Parity A',
    ZONE_A,
  );
  db.prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)').run(
    RESTAURANT_B,
    'Parity B',
    ZONE_A,
  );
  const insertTable = db.prepare('INSERT INTO dining_table (id, restaurant_id, seats) VALUES (?, ?, ?)');
  for (const [id, seats] of OWN_TABLES) insertTable.run(id, RESTAURANT_A, seats);
  insertTable.run(FOREIGN_TABLE, RESTAURANT_B, 12);
  insertTable.run('b-2', RESTAURANT_B, 2);

  const insertHours = db.prepare(
    'INSERT INTO restaurant_hours (restaurant_id, weekday, opens_min, closes_min) VALUES (?, ?, ?, ?)',
  );
  for (const restaurantId of [RESTAURANT_A, RESTAURANT_B]) {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      insertHours.run(restaurantId, weekday, 11 * 60, 23 * 60);
    }
  }

  // The known bookings every case is measured against: a-2 held 19:00-19:45 and a-4x held
  // 19:30-20:30, so the grid holds starts that overlap the first, the last, or the whole of a
  // held booking, and starts that touch none of it.
  reserve(db, {
    restaurantId: RESTAURANT_A,
    tableIds: ['a-2'],
    partySize: 2,
    localStart: `${LOCAL_DAY}T19:00`,
    durationMin: 45,
  });
  reserve(db, {
    restaurantId: RESTAURANT_A,
    tableIds: ['a-4x'],
    partySize: 4,
    localStart: `${LOCAL_DAY}T19:30`,
    durationMin: 60,
  });

  // Stage 1's resolver scans 385 candidate offsets per call, which costs about 19 ms, so the
  // five starts this grid uses are resolved once here instead of once per case. `reserve()`
  // still resolves each of its own inputs — that cost is the price of parity, which has to ask
  // the real write path rather than a stand-in.
  startUtcByLocal = new Map(
    START_LOCALS.map((localTime) => {
      const localStart = `${LOCAL_DAY}T${localTime}`;
      return [localStart, resolveLocalStartInstant(localStart, ZONE_A)] as const;
    }),
  );
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('isSlotBookable and reserve() agree: every offered slot is reservable', (t) => {
  const seats = ownTableSeats();
  let cases = 0;
  let offered = 0;
  let refused = 0;
  const mismatch: string[] = [];

  const record = (label: string, bookable: boolean, attempt: Attempt): void => {
    cases += 1;
    if (bookable) offered += 1;
    else refused += 1;
    if (bookable !== attempt.ok || (!bookable && !ALLOWED_REFUSALS.has(attempt.code as string))) {
      mismatch.push(label);
    }
  };

  // ---- pass 1: the published predicate, over table sets it can carry a party for.
  for (const tableIds of TABLE_SETS) {
    const own = tableIds.filter((id) => seats.has(id));
    const capacity =
      own.length > 0 && own.length === tableIds.length
        ? Math.min(...own.map((id) => seats.get(id) as number))
        : 1;
    for (const partySize of PARTY_SIZES.filter((size) => size <= capacity)) {
      for (const durationMin of DURATIONS) {
        for (const localTime of START_LOCALS) {
          const localStart = `${LOCAL_DAY}T${localTime}`;
          const startUtc = startUtcByLocal.get(localStart) as string;
          const bookable = isSlotBookable(db, RESTAURANT_A, [...tableIds], startUtc, durationMin);
          const attempt = attemptReserve({
            restaurantId: RESTAURANT_A,
            tableIds: [...tableIds],
            partySize,
            localStart,
            durationMin,
          });
          record(
            caseLabel({ tableIds, partySize, durationMin, localStart, bookable, attempt, prefix: 'pass 1' }),
            bookable,
            attempt,
          );
        }
      }
    }
  }

  // ---- pass 2: the composed search the endpoint serves, over the full party-size range.
  for (const partySize of PARTY_SIZES) {
    for (const durationMin of DURATIONS) {
      for (const localTime of START_LOCALS) {
        const localStart = `${LOCAL_DAY}T${localTime}`;
        const startUtc = startUtcByLocal.get(localStart) as string;
        const combination = findTableCombination(db, RESTAURANT_A, partySize, startUtc, durationMin);
        const bookable = combination !== null;
        const tableIds = combination?.tableIds ?? [probeTableId(partySize)];
        const attempt = attemptReserve({
          restaurantId: RESTAURANT_A,
          tableIds: [...tableIds],
          partySize,
          localStart,
          durationMin,
        });
        record(
          caseLabel({ tableIds, partySize, durationMin, localStart, bookable, attempt, prefix: 'pass 2' }),
          bookable,
          attempt,
        );
      }
    }
  }

  t.diagnostic(
    `enumerated grid: ${cases} cases (${TABLE_SETS.length} table sets, ` +
      `${PARTY_SIZES.length} party sizes, ${DURATIONS.length} durations, ${START_LOCALS.length} start quanta); ` +
      `${offered} offered by the search, ${refused} refused, ${mismatch.length} parity mismatches`,
  );

  assert.deepEqual(mismatch, [], `search/write parity violated in ${mismatch.length} case(s)`);
  // The floor is the shape of the enumerated space, not a target: 13 table sets x the party
  // sizes each set can carry x 4 durations x 5 start quanta, plus the composed pass. Every
  // case costs one real write transaction, so the count is bounded by what a serialised suite
  // can afford — not by what it thinks to check.
  assert.ok(cases > 500, `the grid must be enumerated, not hand-listed: only ${cases} cases ran`);
  assert.ok(offered > 0, 'the grid never offered a slot, so it proved nothing in the true direction');
  assert.ok(refused > 0, 'the grid never refused a slot, so it proved nothing in the false direction');

  // The grid restores every booking it made, so the only occupancy left is the fixture's:
  // three quanta on a-2 and four on a-4x.
  const held = db.prepare('SELECT COUNT(*) AS n FROM occupancy').get() as { n: number };
  assert.equal(held.n, 7);
  const confirmed = db
    .prepare("SELECT COUNT(*) AS n FROM booking WHERE status = 'confirmed'")
    .get() as { n: number };
  assert.equal(confirmed.n, 2, 'only the two fixture bookings remain confirmed');
});