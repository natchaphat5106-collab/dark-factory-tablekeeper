/**
 * Unit 7 — full time-zone suite.
 *
 * Claims: at least 30 zones are exercised; every sub-hour offset in the runtime's IANA
 * database is covered; every resolution round-trips to the requested wall clock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_SUB_HOUR_OFFSETS,
  assertResolvableEverywhere,
  listSubHourZones,
  offsetMinutesAt,
} from './timezone-suite.ts';

describe('offsetMinutesAt', () => {
  it('reads whole and sub-hour offsets', () => {
    const jan = Date.UTC(2026, 0, 15, 12, 0, 0);
    assert.equal(offsetMinutesAt('UTC', jan), 0);
    assert.equal(offsetMinutesAt('Asia/Kathmandu', jan), 345);
    assert.equal(offsetMinutesAt('Australia/Eucla', jan), 525);
    assert.equal(offsetMinutesAt('Pacific/Chatham', jan), 825);
  });
});

describe('listSubHourZones', () => {
  it('finds the sub-hour zones and no whole-hour ones', () => {
    const zones = listSubHourZones();
    assert.ok(zones.length >= 10, `expected >= 10 sub-hour zones, got ${zones.length}`);
    for (const entry of zones) {
      assert.ok(entry.offsets.some((offset) => offset % 60 !== 0), `${entry.zone} is not sub-hour`);
    }

    const offsets = new Set(zones.flatMap((entry) => entry.offsets));
    for (const required of REQUIRED_SUB_HOUR_OFFSETS) {
      assert.ok(offsets.has(required), `missing sub-hour offset ${required}`);
    }
  });
});

describe('assertResolvableEverywhere', () => {
  it('resolves every probed zone and returns a complete report', () => {
    const report = assertResolvableEverywhere();

    assert.ok(report.zonesChecked >= 30, `expected >= 30 zones, got ${report.zonesChecked}`);
    assert.equal(report.resolutions, report.zonesChecked * 2);
    assert.ok(report.subHourZones.length >= 10);
    for (const required of REQUIRED_SUB_HOUR_OFFSETS) {
      assert.ok(report.subHourOffsets.includes(required), `missing offset ${required}`);
    }
    assert.equal(report.subHourZones.length + report.wholeHourZones, report.zonesChecked);
  });
});
