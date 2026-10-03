/**
 * The read side: which tables can seat a party at a given instant, and therefore which slots
 * the service may offer.
 *
 * This module never writes. It reads `occupancy` and `dining_table` and answers one question —
 * "could `reserve()` accept these tables at this start?" — and that question is answered by
 * the predicates below rather than by re-deriving availability from booking rows. If search and
 * the write path ever disagree, the write path is right by construction and the search is the
 * bug, so every predicate here is written to be no weaker than its counterpart in
 * stage-1/src/bookings.ts.
 *
 * `occupancy` has exactly one writer in this service, at every stage, and it is stage 1's
 * booking path. Nothing here may become a second one: a search that reserves is a search that
 * can double-book. There is also no cache — a cache is a second copy of `occupancy` and goes
 * stale in exactly the direction that produces false `true`s.
 */

import { ApiError, isApiError, toErrorResponse } from '../../stage-1/src/errors.ts';
import type { Db } from '../../stage-1/src/db.ts';
import { createRequestListener } from '../../stage-1/src/routes.ts';
import { findLocalStartCandidates } from '../../stage-1/src/timezone.ts';
import {
  QUANTUM_MINUTES,
  assertDuration,
  assertOnQuantumGrid,
  assertPartySize,
  quantumStarts,
} from '../../stage-1/src/slots.ts';
import {
  assertWithinHours,
  getHours,
  localStartString,
  restaurantTimezone,
  weekdayOfLocalDate,
} from './hours.ts';

/**
 * The largest set of tables one search will consider.
 *
 * A bound, because candidate sets are enumerated combinatorially and an unbounded search is
 * 2^n over a restaurant's inventory. Stage 1's `reserve()` accepts any number of table ids, so
 * this is a search-side bound only, and it is one a reviewer can see rather than an emergent
 * one.
 */
const MAX_TABLES_PER_BOOKING = 1;

type TableRow = { id: string; seats: number };

/**
 * Could `reserve()` accept these tables at this start?
 *
 * `true` means: every requested table is at this restaurant, the start is a canonical instant
 * on the 15-minute grid, every one of the tables holds no `occupancy` row for any quantum the
 * booking would cover, and the slot falls inside service hours. Every one of those is a
 * condition stage 1's write path also refuses on, so a `true` here is a promise the write side
 * keeps.
 *
 * It reports absence rather than throwing. Search answering "no" and the write path answering
 * "no" are the same fact reached from two directions; search turning a refusal into an
 * exception would let a read take on the authority of a write.
 *
 * The seat capacity of the party is not checked here, because the signature TASK.md §4 fixes
 * carries no party size: a party of four and a party of eight are the same table set and the
 * same slot. The capacity predicate lives in `findTableCombination`, which is given a party,
 * and every search call site is their composition.
 */
export function isSlotBookable(
  db: Db,
  restaurantId: string,
  tableIds: string[],
  startUtc: string,
  durationMin: number,
): boolean {
  try {
    const requested = requestedTableIds(tableIds);
    const duration = assertDuration(durationMin);
    // A canonical instant on the booking grid: stage 1 refuses a start that is 19:07 rather
    // than rounding it, and a search that offers it would be offering something unwritable.
    assertOnQuantumGrid(startUtc, 'start_utc');

    // Restaurant scoping, per identifier. A table id on its own is not authority to offer it:
    // it was stage 1's original defect, and the failure it produced — one restaurant's
    // inventory being offered to another — is invisible unless the scope is in this query.
    const readTable = db.prepare('SELECT id FROM dining_table WHERE id = ? AND restaurant_id = ?');
    for (const tableId of requested) {
      if (readTable.get(tableId, restaurantId) === undefined) return false;
    }

    // Service hours. Outside them this is stricter than stage 1's write path, which has no
    // hours check at all; being stricter is the safe direction, and a refusal here beside a
    // write that accepts is the documented one-directional case.
    assertWithinHours(db, restaurantId, startUtc, duration);

    const quanta = quantumStarts(startUtc, duration);
    // Occupancy is read per requested table and scoped by the owning restaurant, so a row
    // under a foreign table id can never be read as this restaurant's availability. The
    // quanta are exactly the ones stage 1 would insert for this booking, which is what makes
    // the partial-overlap case correct: a table held 19:00-19:45 is unavailable to a 19:30
    // start, not only to a 19:00 one.
    const readOccupancy = db.prepare(
      `SELECT 1 AS held FROM occupancy o
         JOIN dining_table t ON t.id = o.dining_table_id
        WHERE t.restaurant_id = ?
          AND o.dining_table_id = ?
          AND o.quantum_start_utc IN (${quanta.map(() => '?').join(',')})`,
    );
    for (const tableId of requested) {
      if (readOccupancy.get(restaurantId, tableId, ...quanta) !== undefined) return false;
    }
    return true;
  } catch (err) {
    if (isApiError(err)) return false;
    throw err;
  }
}

/**
 * The tables that cover a party at one instant, or `null` when nothing can.
 *
 * `null` is the answer, not an exception. The write path owns refusals; search reports absence,
 * and conflating the two is how a search starts refusing writes.
 *
 * The seat rule is stage 1's rule and not a restaurant heuristic. `reserve()` refuses a
 * request when `party_size` exceeds the seats of any single table it was given
 * (stage-1/src/bookings.ts, the `TABLE_TOO_SMALL` branch). Summing seats across a set would
 * offer `{4,4}` for a party of six and the write path would answer `TABLE_TOO_SMALL` — a slot
 * offered and then refused, which is the one defect this stage exists to prevent. So every
 * table in a workable set seats the party. That also means one table is sufficient whenever a
 * set is, and the multi-table branches below exist because the seat rule is stage 1's rather
 * than a law: if the write path ever gains a split-party rule, this solver is already correct.
 *
 * `restaurantId` is a required positional argument with no default, and it appears in every
 * query here. The stage-1 defect this is guarding against was exactly a table lookup keyed on
 * id alone, and stage 2 is where a reusable "find bookable tables" helper is finally written,
 * so an optional trailing `restaurantId` with an unscoped fallback would reproduce it verbatim.
 *
 * Ordering is tightest first — least total seats, then fewest tables, then table id order — so
 * the answer does not depend on the order rows happen to come back in. A first-fit scan in
 * arrival order would hand a party of two an eight-seat table while a two-seat table sits free.
 */
export function findTableCombination(
  db: Db,
  restaurantId: string,
  partySize: number,
  startUtc: string,
  durationMin: number,
): { tableIds: string[]; seats: number } | null {
  const size = assertPartySize(partySize);
  const duration = assertDuration(durationMin);
  restaurantTimezone(db, restaurantId);

  const tables = db
    .prepare('SELECT id, seats FROM dining_table WHERE restaurant_id = ? ORDER BY seats ASC, id ASC')
    .all(restaurantId) as TableRow[];

  const seatsById = new Map(tables.map((table) => [table.id, table.seats]));
  // One definition of "workable" in this service: the predicate the parity test pins.
  const workable = new Map<string, boolean>();
  const tableWorks = (tableId: string): boolean => {
    const cached = workable.get(tableId);
    if (cached !== undefined) return cached;
    const result = isSlotBookable(db, restaurantId, [tableId], startUtc, duration);
    workable.set(tableId, result);
    return result;
  };

  for (const candidate of candidateTableSets(tables, size, seatsById)) {
    if (candidate.every(tableWorks)) {
      return {
        tableIds: [...candidate],
        seats: candidate.reduce((total, tableId) => total + (seatsById.get(tableId) as number), 0),
      };
    }
  }
  return null;
}

/** Every candidate set, tightest first. See `findTableCombination` for the seat rule and the order. */
function candidateTableSets(tables: TableRow[], partySize: number, seatsById: Map<string, number>): string[][] {
  const eligible = tables.filter((table) => table.seats >= partySize);
  const sets: string[][] = [];
  const widest = Math.min(MAX_TABLES_PER_BOOKING, eligible.length);
  for (let width = 1; width <= widest; width += 1) {
    collectCombinations(eligible, width, 0, [], sets);
  }
  const totalSeats = (set: string[]): number =>
    set.reduce((total, tableId) => total + (seatsById.get(tableId) as number), 0);
  return sets.sort(
    (left, right) =>
      totalSeats(left) - totalSeats(right) ||
      left.length - right.length ||
      left.join('\u0000').localeCompare(right.join('\u0000')),
  );
}

function collectCombinations(
  eligible: TableRow[],
  width: number,
  from: number,
  chosen: string[],
  out: string[][],
): void {
  if (chosen.length === width) {
    out.push([...chosen]);
    return;
  }
  for (let index = from; index <= eligible.length - (width - chosen.length); index += 1) {
    chosen.push((eligible[index] as TableRow).id);
    collectCombinations(eligible, width, index + 1, chosen, out);
    chosen.pop();
  }
}

/**
 * The table ids stage 1's write path would accept as input at all, with the same refusals it
 * uses, so a search over a malformed set reports absence instead of crashing on a value SQLite
 * would not have accepted either.
 */
function requestedTableIds(tableIds: unknown): string[] {
  if (!Array.isArray(tableIds) || tableIds.length === 0) {
    throw new ApiError('INVALID_TABLE', 'table_ids must be a non-empty array', {
      table_ids: String(tableIds),
    });
  }
  const ids = tableIds.map((tableId) => {
    if (typeof tableId !== 'string' || tableId === '') {
      throw new ApiError('INVALID_TABLE', 'table_ids must be non-empty strings', {
        table_ids: String(tableIds),
      });
    }
    return tableId;
  });
  if (new Set(ids).size !== ids.length) {
    throw new ApiError('INVALID_TABLE', 'table_ids must not repeat a table', { table_ids: ids });
  }
  return ids;
}

export type AvailabilitySlot = { start_utc: string; start_local: string; table_ids: string[] };

/**
 * The slots a party of `size` could book at this restaurant on this local date.
 *
 * `localDate` is read in the restaurant's own zone: the grid walked here is that zone's wall
 * clock, and each grid point is resolved to a UTC instant by stage 1's resolver. That resolver
 * decides the two time-zone answers without this module knowing either of them — a wall time
 * inside a spring-forward gap yields no candidate and is never offered, and a wall time inside
 * a fall-back overlap yields two, both of which are real instants an hour apart and both of which
 * are offered. Guessing a fold would silently move a booking by an hour.
 *
 * Read-only. Nothing here writes `occupancy`, `idempotency_key`, or a hold of any kind, and a
 * search that reserves is a search that can double-book. A slot offered here can be taken by
 * someone else before you book it; that is the correct answer, not a defect.
 *
 * The candidate loop is a superset and `findTableCombination` is the authority: the loop walks
 * the local grid from opening to the last start that could fit before closing, and every start
 * it produces is asked about through the same predicate `parity.test.ts` pins. Where a DST
 * transition makes a local start's real end land outside the window, the predicate refuses it
 * and no slot appears.
 */
export function searchAvailability(
  db: Db,
  restaurantId: string,
  localDate: string,
  partySize: number,
  durationMin: number,
): AvailabilitySlot[] {
  const size = assertPartySize(partySize);
  const duration = assertDuration(durationMin);
  const weekday = weekdayOfLocalDate(localDate);
  const timezone = restaurantTimezone(db, restaurantId);
  const window = getHours(db, restaurantId, weekday);
  if (window === null) return [];

  const slots: AvailabilitySlot[] = [];
  const lastStart = window.closes - duration;
  for (let minutes = window.opens; minutes <= lastStart; minutes += QUANTUM_MINUTES) {
    const localStart = localStartString(localDate, minutes);
    for (const startUtc of findLocalStartCandidates(localStart, timezone)) {
      const combination = findTableCombination(db, restaurantId, size, startUtc, duration);
      if (combination !== null) {
        slots.push({ start_utc: startUtc, start_local: localStart, table_ids: combination.tableIds });
      }
    }
  }
  return slots.sort((left, right) => left.start_utc.localeCompare(right.start_utc));
}

const ORIGIN = 'http://tablekeeper.invalid';

/**
 * The request listener for the whole service: stage 2's one route, then stage 1's.
 *
 * Stage 1's `createRequestListener` is the authority for every existing route and its status
 * codes, and it is used unchanged. This wraps it, so the new route is purely additive: a path
 * that is not the availability search never reaches stage 2's code at all. Errors from the new
 * route go through stage 1's `toErrorResponse`, which is what keeps the response envelope and
 * the `ERROR_STATUS` mapping identical to every other failure in the service.
 */
export function createStage2RequestListener(
  db: Db,
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  const stage1 = createRequestListener(db);
  return function listener(req, res): void {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', ORIGIN);
    } catch {
      stage1(req, res);
      return;
    }
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const isAvailabilitySearch =
      segments.length === 4 &&
      segments[0] === 'v1' &&
      segments[1] === 'restaurants' &&
      segments[3] === 'availability';
    if (method !== 'GET' || !isAvailabilitySearch) {
      stage1(req, res);
      return;
    }

    try {
      const slots = searchAvailability(
        db,
        segments[2] as string,
        url.searchParams.get('local_date') as string,
        Number(url.searchParams.get('party_size')),
        Number(url.searchParams.get('duration_min')),
      );
      sendJson(res, 200, { slots });
    } catch (err) {
      const failure = toErrorResponse(err);
      sendJson(res, failure.status, failure.body);
    }
  };
}

/** The one response writer for this route, in the same shape stage 1 writes everywhere else. */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}