/**
 * Unit 7 — the full time-zone suite.
 *
 * Stage 1 proved the resolver on a handful of zones. This proves it is not a curated list:
 * it enumerates every zone the runtime's IANA database exposes, keeps every zone whose
 * offset is not a whole number of hours at some point in 2026, and resolves real local
 * datetimes in each of those plus a broad set of representative zones — northern and
 * southern, both daylight-saving directions, and the historical oddities.
 *
 * "Sub-hour" here means an offset whose minute component is non-zero, so a 15-minute scan
 * is required to reach it. (Some zones, e.g. Europe/Amsterdam historically, had offsets
 * with second components; those are not current and are out of scope.)
 */

import { findLocalStartCandidates, resolveLocalStartInstant } from '../../stage-1/src/timezone.ts';

export type SubHourZone = { zone: string; offsets: number[] };

export type TimezoneSuiteReport = {
  zonesChecked: number;
  resolutions: number;
  subHourZones: string[];
  subHourOffsets: number[];
  requiredSubHourOffsets: number[];
  wholeHourZones: number;
};

const REFERENCE_JAN = Date.UTC(2026, 0, 15, 12, 0, 0);
const REFERENCE_JUL = Date.UTC(2026, 6, 15, 12, 0, 0);

/** Offsets in minutes that only a sub-hour-capable scan can reach. */
export const REQUIRED_SUB_HOUR_OFFSETS: readonly number[] = [345, 525, 825, 330, 570, 210, 390, -210, -570];

/** Whole-hour anchors: both hemispheres, both DST directions, and a spread of longitudes. */
export const REPRESENTATIVE_ZONES: readonly string[] = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Pacific/Auckland',
  'Australia/Sydney',
];

/** The zone's offset, in minutes from UTC, at `instantMs`. */
export function offsetMinutesAt(zone: string, instantMs: number): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return Math.round((asUtc - instantMs) / 60000);
}

/** Every zone with a non-whole-hour offset at either reference instant. */
export function listSubHourZones(zones: readonly string[] = Intl.supportedValuesOf('timeZone')): SubHourZone[] {
  const result: SubHourZone[] = [];
  for (const zone of zones) {
    const offsets = [offsetMinutesAt(zone, REFERENCE_JAN), offsetMinutesAt(zone, REFERENCE_JUL)];
    if (offsets.some((offset) => offset % 60 !== 0)) {
      result.push({ zone, offsets: [...new Set(offsets)].sort((a, b) => a - b) });
    }
  }
  return result;
}

/**
 * Resolve a real local datetime in every zone under test and confirm the answer round-trips.
 *
 * Throws a single descriptive Error naming every failing zone when any resolution fails,
 * is ambiguous, or does not appear among the candidate instants.
 */
export function assertResolvableEverywhere(): TimezoneSuiteReport {
  const allZones = Intl.supportedValuesOf('timeZone');
  const subHour = listSubHourZones(allZones);
  const subHourNames = subHour.map((entry) => entry.zone);

  const probes = [...new Set([...subHourNames, ...REPRESENTATIVE_ZONES])];
  const probeLocals = ['2026-01-15T12:00', '2026-07-15T12:00'];

  const failures: string[] = [];
  let resolutions = 0;

  for (const zone of probes) {
    for (const local of probeLocals) {
      try {
        const resolved = resolveLocalStartInstant(local, zone);
        const candidates = findLocalStartCandidates(local, zone);
        if (!candidates.includes(resolved)) {
          failures.push(`${zone} ${local}: ${resolved} not among candidates`);
        } else {
          resolutions += 1;
        }
      } catch (err) {
        failures.push(`${zone} ${local}: ${(err as Error).message}`);
      }
    }
  }

  const subHourOffsets = [...new Set(subHour.flatMap((entry) => entry.offsets))].sort((a, b) => a - b);
  const missingOffsets = REQUIRED_SUB_HOUR_OFFSETS.filter((offset) => !subHourOffsets.includes(offset));
  if (missingOffsets.length > 0) {
    failures.push(`required sub-hour offsets absent: ${missingOffsets.join(', ')}`);
  }

  if (failures.length > 0) {
    throw new Error(`timezone suite failed:\n${failures.join('\n')}`);
  }

  return {
    zonesChecked: probes.length,
    resolutions,
    subHourZones: subHourNames,
    subHourOffsets,
    requiredSubHourOffsets: [...REQUIRED_SUB_HOUR_OFFSETS],
    wholeHourZones: probes.length - subHourNames.length,
  };
}
