/**
 * The 15-minute occupancy quantum grid.
 *
 * A booking is not one occupied row; it is one occupied row per quantum it covers.
 * That is the whole reason the primary key in schema.sql is sufficient: two bookings
 * that overlap in time necessarily share at least one quantum start, and two bookings
 * that do not overlap share none. Keying occupancy on the booking's start time instead
 * would let 19:00 and 19:30 ninety-minute bookings both succeed.
 */

import { ApiError } from './errors.ts';
import { formatInstant } from './timezone.ts';

export const QUANTUM_MINUTES = 15;

/**
 * The longest booking a single request may create, in minutes.
 *
 * A ceiling, not a preference. Each minute of duration is one more occupancy row per
 * table, written inside the one global write transaction, so an unbounded duration_min
 * lets a single small request demand unbounded work: 1,500,000 minutes is 100,040 rows
 * and about 23 MB, all under the write lock that every other writer in the service is
 * waiting on. Twelve hours is well past any real table booking and caps one request at
 * 48 rows per table.
 */
export const MAX_DURATION_MINUTES = 720;

const QUANTUM_MS = QUANTUM_MINUTES * 60000;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function instantToMs(instant: string): number {
  if (!CANONICAL_INSTANT.test(instant)) {
    throw new ApiError('INVALID_TIME', 'instant must be a canonical UTC instant', { instant });
  }
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new ApiError('INVALID_TIME', 'instant is not a real instant', { instant });
  }
  return ms;
}

/**
 * The restaurant cannot seat a party at 19:07, so a resolved start that is not on the
 * grid is refused rather than rounded. Rounding would silently move the booking.
 */
export function assertOnQuantumGrid(instant: string, field: string): void {
  const ms = instantToMs(instant);
  if (((ms % QUANTUM_MS) + QUANTUM_MS) % QUANTUM_MS !== 0) {
    throw new ApiError('INVALID_DURATION', `${field} is not on the 15-minute booking grid`, {
      field,
      [field]: instant,
      quantum_minutes: QUANTUM_MINUTES,
    });
  }
}

export function assertDuration(durationMin: unknown): number {
  if (typeof durationMin !== 'number' || !Number.isInteger(durationMin) || durationMin <= 0) {
    throw new ApiError('INVALID_DURATION', 'duration_min must be a positive integer', {
      duration_min: String(durationMin),
    });
  }
  if (durationMin % QUANTUM_MINUTES !== 0) {
    throw new ApiError('INVALID_DURATION', `duration_min must be a positive multiple of ${QUANTUM_MINUTES}`, {
      duration_min: durationMin,
      quantum_minutes: QUANTUM_MINUTES,
    });
  }
  if (durationMin > MAX_DURATION_MINUTES) {
    throw new ApiError('INVALID_DURATION', `duration_min must not exceed ${MAX_DURATION_MINUTES}`, {
      duration_min: durationMin,
      max_duration_minutes: MAX_DURATION_MINUTES,
    });
  }
  return durationMin;
}

export function assertPartySize(partySize: unknown): number {
  if (typeof partySize !== 'number' || !Number.isInteger(partySize) || partySize <= 0) {
    throw new ApiError('INVALID_PARTY_SIZE', 'party_size must be a positive integer', {
      party_size: String(partySize),
    });
  }
  return partySize;
}

/** Every quantum start a booking of `durationMin` covers, ascending. */
export function quantumStarts(startUtc: string, durationMin: number): string[] {
  const start = instantToMs(startUtc);
  const quanta = durationMin / QUANTUM_MINUTES;
  const starts: string[] = [];
  for (let index = 0; index < quanta; index += 1) {
    starts.push(formatInstant(start + index * QUANTUM_MS));
  }
  return starts;
}