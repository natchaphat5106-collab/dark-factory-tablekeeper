/**
 * Hours of operation, and whether a booking fits inside them.
 *
 * Every wall-clock number in this module — the weekday, the minutes past local midnight —
 * is the restaurant's own, never the caller's and never the host's. A booking at
 * `2026-10-02T23:00Z` is `2026-10-03T08:00` on a Friday-morning clock in Asia/Tokyo and
 * `2026-10-02T19:00` on a Thursday-evening one in America/New_York, and the two disagree
 * about both the weekday and the service window. Storing hours in UTC would make the table
 * unreadable and the DST behaviour wrong.
 *
 * The local -> UTC direction is not implemented here: `resolveLocalStartInstant` from stage 1
 * is the only resolver in the service, and this module calls it. What stage 1 does not provide
 * is the inverse — an instant's wall clock in a named zone — so that is the one formatter built
 * here, and it takes an explicit `timeZone` and reads nothing from the host.
 *
 * SCOPE LIMIT — closing past local midnight is out of scope. A restaurant open until 01:00 is
 * one row with `closes_min = 1440` plus the next weekday's row. A booking whose end lands on
 * the next local calendar day at any minute other than 00:00 is refused rather than guessed at,
 * because half-modelling the crossover would silently accept a booking whose real end is
 * outside the service window. Crossover belongs to a later stage; this comment exists so the
 * next seat inherits a stated contract instead of an ambiguous one.
 */

import { ApiError } from '../../stage-1/src/errors.ts';
import { inImmediateTransaction, migrate, type Db } from '../../stage-1/src/db.ts';
import { formatInstant } from '../../stage-1/src/timezone.ts';
import { assertDuration, instantToMs } from '../../stage-1/src/slots.ts';

/** Stage 2's row in stage 1's ledger. One ledger, not two: "has this run?" has one answer. */
const HOURS_MIGRATION = '0002_restaurant_hours';

const MINUTES_PER_DAY = 1440;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ServiceWindow = { opens: number; closes: number };

/** An instant read on the restaurant's own clock. */
export type ZonePosition = { weekday: number; minutes: number; date: string };

/**
 * Apply the `restaurant_hours` table once, recorded in stage 1's `schema_migration`.
 *
 * Stage 1's own `migrate()` is called first: it is idempotent, and it guarantees the ledger
 * exists, so "has this run?" can be asked before anything has been written — which is the
 * property the ledger was built for. A second ledger would give two answers to that question.
 */
export function migrate2(db: Db): void {
  migrate(db);
  if (hoursMigrationApplied(db)) return;
  inImmediateTransaction(db, () => {
    if (hoursMigrationApplied(db)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS restaurant_hours (
      restaurant_id TEXT NOT NULL REFERENCES restaurant(id),
      weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      opens_min     INTEGER NOT NULL CHECK (opens_min >= 0 AND opens_min < 1440),
      closes_min    INTEGER NOT NULL CHECK (closes_min > 0 AND closes_min <= 1440),
      PRIMARY KEY (restaurant_id, weekday)
    )`);
    db.prepare('INSERT INTO schema_migration (name, applied_at_utc) VALUES (?, ?)').run(
      HOURS_MIGRATION,
      formatInstant(Date.now()),
    );
  });
}

function hoursMigrationApplied(db: Db): boolean {
  return (
    db.prepare('SELECT 1 AS present FROM schema_migration WHERE name = ?').get(HOURS_MIGRATION) !==
    undefined
  );
}

/** The restaurant's IANA zone, or a 404-shaped refusal for an unknown or unnamed restaurant. */
export function restaurantTimezone(db: Db, restaurantId: string): string {
  if (typeof restaurantId !== 'string' || restaurantId === '') {
    throw new ApiError('NOT_FOUND', 'no such restaurant', { restaurant_id: String(restaurantId) });
  }
  const row = db.prepare('SELECT timezone FROM restaurant WHERE id = ?').get(restaurantId) as
    | { timezone: string }
    | undefined;
  if (row === undefined || row.timezone === undefined) {
    throw new ApiError('NOT_FOUND', 'no such restaurant', { restaurant_id: restaurantId });
  }
  return row.timezone;
}

/**
 * The service window for one weekday, or `null` when the restaurant is closed.
 *
 * An absent row means closed, not open. That is the fail-closed reading: the alternative
 * silently offers every slot at every restaurant that has no hours configured.
 */
export function getHours(db: Db, restaurantId: string, weekday: number): ServiceWindow | null {
  assertWeekday(weekday);
  const row = db
    .prepare('SELECT opens_min, closes_min FROM restaurant_hours WHERE restaurant_id = ? AND weekday = ?')
    .get(restaurantId, weekday) as { opens_min: number; closes_min: number } | undefined;
  if (row === undefined) return null;
  return { opens: row.opens_min, closes: row.closes_min };
}

function assertWeekday(weekday: number): void {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ApiError('INVALID_TIME', 'weekday must be an integer between 0 (Sunday) and 6', {
      weekday: String(weekday),
    });
  }
}

/**
 * Read a canonical UTC instant on the restaurant's clock.
 *
 * The weekday comes from pure calendar arithmetic on the wall-clock date, so it cannot be
 * influenced by the host zone. `date` is `YYYY-MM-DD` on that same clock, which is what makes
 * the next-day-closing case expressible.
 */
export function zonePosition(startUtc: string, timezone: string): ZonePosition {
  const ms = instantToMs(startUtc);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const hours = read('hour');
  const minutes = read('minute');
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(year)) {
    throw new ApiError('INTERNAL', 'the time zone could not be read', { timezone });
  }
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(), minutes: hours * 60 + minutes, date };
}

/** `YYYY-MM-DDTHH:MM` for a local date and a minute of that day — the shape `reserve()` accepts. */
export function localStartString(date: string, minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${date}T${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The weekday a local `YYYY-MM-DD` falls on, refusing anything that is not a real date. */
export function weekdayOfLocalDate(localDate: unknown): number {
  if (typeof localDate !== 'string') {
    throw new ApiError('INVALID_TIME', 'local_date must be a string of the form YYYY-MM-DD', {
      local_date: String(localDate),
    });
  }
  const parts = LOCAL_DATE_PATTERN.exec(localDate);
  if (parts === null) {
    throw new ApiError('INVALID_TIME', 'local_date must match YYYY-MM-DD', { local_date: localDate });
  }
  const [year, month, day] = parts.slice(1).map(Number) as [number, number, number];
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new ApiError('INVALID_TIME', 'local_date is not a real calendar date', { local_date: localDate });
  }
  return roundTrip.getUTCDay();
}

/**
 * Refuse a booking that starts before opening, ends after closing, or falls on a weekday the
 * restaurant is closed.
 *
 * The end is the booking's *real* end instant — start plus `duration_min` of elapsed time —
 * read on the restaurant's clock. On a spring-forward day that is not the same as adding the
 * minutes to the wall clock: 01:30 EST plus 60 real minutes is 03:30 EDT, two hours later on
 * the wall clock and 90 wall-clock minutes after the start. Adding wall-clock minutes would
 * let a booking end at a time that does not exist.
 */
export function assertWithinHours(db: Db, restaurantId: string, startUtc: string, durationMin: number): void {
  const timezone = restaurantTimezone(db, restaurantId);
  const duration = assertDuration(durationMin);
  const start = zonePosition(startUtc, timezone);
  const end = zonePosition(formatInstant(instantToMs(startUtc) + duration * 60000), timezone);
  const endMinutes = endMinuteOfDay(start, end, restaurantId, timezone);
  const window = getHours(db, restaurantId, start.weekday);

  if (window === null) {
    throw new ApiError('INVALID_TIME', 'the restaurant is closed on that weekday', {
      restaurant_id: restaurantId,
      timezone,
      local_date: start.date,
      weekday: start.weekday,
    });
  }
  if (start.minutes < window.opens) {
    throw new ApiError('INVALID_TIME', 'the booking starts before the restaurant opens', {
      restaurant_id: restaurantId,
      timezone,
      local_start_minutes: start.minutes,
      opens_minutes: window.opens,
    });
  }
  if (endMinutes > window.closes) {
    throw new ApiError('INVALID_TIME', 'the booking ends after the restaurant closes', {
      restaurant_id: restaurantId,
      timezone,
      local_end_minutes: endMinutes,
      closes_minutes: window.closes,
    });
  }
}

/**
 * Where the booking's end falls on the service day, in minutes past local midnight.
 *
 * `closes_min = 1440` is "closes at midnight", so an end that lands exactly on 00:00 of the
 * next local day is still inside that service day. Any other next-day end is a past-midnight
 * closing, which this stage does not model and therefore refuses.
 */
function endMinuteOfDay(start: ZonePosition, end: ZonePosition, restaurantId: string, timezone: string): number {
  if (end.date === start.date) return end.minutes;
  if (end.minutes === 0) return MINUTES_PER_DAY;
  throw new ApiError('INVALID_TIME', 'a booking ending on the next local day is not modelled by closes_min', {
    restaurant_id: restaurantId,
    timezone,
    local_start_date: start.date,
    local_end_date: end.date,
  });
}