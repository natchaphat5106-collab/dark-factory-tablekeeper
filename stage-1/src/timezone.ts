/**
 * Local wall time -> UTC instant, and the canonical instant string.
 *
 * Every conversion takes an explicit IANA zone. Nothing here reads `process.env.TZ`,
 * the system zone, or the host locale, which is why the suite passes unchanged under
 * `TZ=Pacific/Kiritimati`.
 *
 * Resolution is a scan over candidate UTC offsets at 15-minute granularity, not a
 * whole-hour one. Asia/Kathmandu (+05:45), Australia/Eucla (+08:45) and
 * Pacific/Chatham (+12:45/+13:45) have no whole-hour offset at all, so a whole-hour
 * scan returns no candidate for them and reports a plausible-looking "that local time
 * does not exist" for times that plainly do. Candidates are generated from real
 * offsets and then confirmed by an Intl round trip, so an offset that is not a whole
 * number of hours still produces the right instant.
 */

import { ApiError } from './errors.ts';

const LOCAL_START_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const OFFSET_SCAN_WINDOW_MINUTES = 48 * 60;
const OFFSET_SCAN_STEP_MINUTES = 15;

export type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/** The one canonical instant format: lexicographic order is chronological order. */
export function formatInstant(ms: number): string {
  return new Date(ms).toISOString();
}

export function assertResolvableZone(timezone: unknown): string {
  if (typeof timezone !== 'string' || timezone === '') {
    throw new ApiError('INVALID_TIMEZONE', 'timezone must be a non-empty IANA zone id', {
      timezone: String(timezone),
    });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new ApiError('INVALID_TIMEZONE', 'timezone is not resolvable by Intl', { timezone });
  }
  return timezone;
}

export function parseLocalStart(localStart: unknown): WallClock {
  if (typeof localStart !== 'string') {
    throw new ApiError('INVALID_TIME', 'local_start must be a string of the form YYYY-MM-DDTHH:MM', {
      local_start: String(localStart),
    });
  }
  const parts = LOCAL_START_PATTERN.exec(localStart);
  if (parts === null) {
    throw new ApiError('INVALID_TIME', 'local_start must match YYYY-MM-DDTHH:MM with no offset', {
      local_start: localStart,
    });
  }
  const [year, month, day, hour, minute] = parts.slice(1).map(Number) as [
    number, number, number, number, number,
  ];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const roundTrip = new Date(asUtc);
  const calendarValid =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute;
  if (!calendarValid || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new ApiError('INVALID_TIME', 'local_start is not a real calendar date and time', {
      local_start: localStart,
    });
  }
  return { year, month, day, hour, minute };
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function wallClockAt(ms: number, formatter: Intl.DateTimeFormat): WallClock {
  const parts = formatter.formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
  );
}

/**
 * Every UTC instant whose wall time in `timezone` equals `local`, ascending.
 *
 * Exposed so a test can assert the candidate count (0 for a spring-forward gap, 2 for
 * a fall-back overlap) instead of trusting that a resolution happened by rule.
 */
export function findLocalStartCandidates(localStart: string, timezone: string): string[] {
  assertResolvableZone(timezone);
  const wall = parseLocalStart(localStart);
  const formatter = formatterFor(timezone);
  const naiveUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  // The scan is anchored at zero, not at the zone's current offset, so the step is what
  // decides which offsets are reachable. Anchor it at the zone offset and the first
  // candidate is always correct, which would make the granularity untestable: a
  // whole-hour step would then still resolve Kathmandu, and the bug the task calls out
  // would be invisible here while still shipping to every zone that has one.
  const candidates = new Set<number>();
  for (
    let offset = -OFFSET_SCAN_WINDOW_MINUTES;
    offset <= OFFSET_SCAN_WINDOW_MINUTES;
    offset += OFFSET_SCAN_STEP_MINUTES
  ) {
    const instant = naiveUtc - offset * 60000;
    if (sameWallClock(wallClockAt(instant, formatter), wall)) candidates.add(instant);
  }
  return [...candidates].sort((a, b) => a - b).map(formatInstant);
}

/**
 * Resolve a requested local start to exactly one instant, or refuse.
 *
 * 0 candidates means the wall time does not exist (spring-forward gap). 2 candidates
 * means it is ambiguous (fall-back overlap) and the caller must say which one it meant
 * with `fold: 0` (earlier) or `fold: 1` (later). Guessing either way is a defect: it
 * silently moves a booking by an hour.
 */
export function resolveLocalStartInstant(localStart: string, timezone: string, fold?: unknown): string {
  const requestedFold = fold === null ? undefined : fold;
  const candidates = findLocalStartCandidates(localStart, timezone);

  if (candidates.length === 0) {
    throw new ApiError('INVALID_TIME', 'local_start does not exist in this time zone', {
      local_start: localStart,
      timezone,
    });
  }
  if (candidates.length === 1) {
    const only = candidates[0] as string;
    if (requestedFold !== undefined && requestedFold !== 0 && requestedFold !== 1) {
      throw new ApiError('INVALID_TIME', 'fold must be 0 or 1', { fold: String(requestedFold) });
    }
    return only;
  }

  if (requestedFold === 0) return candidates[0] as string;
  if (requestedFold === 1) return candidates[candidates.length - 1] as string;
  if (requestedFold !== undefined) {
    throw new ApiError('INVALID_TIME', 'fold matches no candidate instant', {
      fold: String(requestedFold),
      candidates,
    });
  }
  throw new ApiError('AMBIGUOUS_LOCAL_TIME', 'local_start occurs twice in this time zone; send fold 0 or 1', {
    local_start: localStart,
    timezone,
    candidates,
  });
}