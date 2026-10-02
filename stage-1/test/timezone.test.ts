/**
 * Time-zone resolution: the spring-forward gap, the fall-back overlap, `fold`, and
 * sub-hour offsets in both hemispheres.
 *
 * Every assertion is an exact UTC instant or an exact response code. "It booked
 * something" is not an assertion here, because a whole-hour offset scan also books
 * something — in every zone the author happens to live in.
 *
 * Nothing in this file reads `process.env.TZ`, and one test deliberately moves it to
 * prove that changing the ambient zone changes nothing.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server.ts';
import { findLocalStartCandidates, resolveLocalStartInstant } from '../src/timezone.ts';

let dir: string;
let service: StartedServer;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tablekeeper-tz-'));
  service = await startServer(join(dir, 'stage1.db'));
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

type BookingAttempt = { status: number; code: string | null; startUtc: string | null };

/** A fresh restaurant and table, so one case can never be refused for a previous one's slot. */
async function attempt(timezone: string, localStart: string, fold?: number): Promise<BookingAttempt> {
  const restaurant = (await (await post('/v1/restaurants', { name: timezone, timezone })).json()) as {
    id: string;
  };
  const table = (await (
    await post(`/v1/restaurants/${restaurant.id}/tables`, { seats: 8 })
  ).json()) as { id: string };

  const payload: Record<string, unknown> = {
    restaurant_id: restaurant.id,
    table_ids: [table.id],
    party_size: 2,
    local_start: localStart,
    duration_min: 30,
  };
  if (fold !== undefined) payload.fold = fold;

  const response = await post('/v1/bookings', payload);
  const body = (await response.json()) as { id?: string; start_utc?: string; error?: { code?: string } };
  return {
    status: response.status,
    code: body.error?.code ?? null,
    startUtc: body.start_utc ?? null,
  };
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('spring-forward gap: America/New_York 02:30 on 2026-03-08 does not exist', async () => {
  assert.deepEqual(findLocalStartCandidates('2026-03-08T02:30', 'America/New_York'), []);
  assert.deepEqual(await attempt('America/New_York', '2026-03-08T02:30'), {
    status: 400,
    code: 'INVALID_TIME',
    startUtc: null,
  });
});

test('fall-back overlap: America/New_York 01:30 on 2026-11-01 is refused without fold', async () => {
  assert.deepEqual(findLocalStartCandidates('2026-11-01T01:30', 'America/New_York'), [
    '2026-11-01T05:30:00.000Z',
    '2026-11-01T06:30:00.000Z',
  ]);
  assert.deepEqual(await attempt('America/New_York', '2026-11-01T01:30'), {
    status: 400,
    code: 'AMBIGUOUS_LOCAL_TIME',
    startUtc: null,
  });
});

test('fold: 0 takes the earlier instant of an overlap, 05:30Z', async () => {
  const result = await attempt('America/New_York', '2026-11-01T01:30', 0);
  assert.deepEqual(result, { status: 201, code: null, startUtc: '2026-11-01T05:30:00.000Z' });
});

test('fold: 1 takes the later instant of an overlap, 06:30Z', async () => {
  const result = await attempt('America/New_York', '2026-11-01T01:30', 1);
  assert.deepEqual(result, { status: 201, code: null, startUtc: '2026-11-01T06:30:00.000Z' });
});

test('a fold that matches no candidate is refused, not guessed', async () => {
  assert.throws(
    () => resolveLocalStartInstant('2026-11-01T01:30', 'America/New_York', 7),
    (err: { code?: string }) => err.code === 'INVALID_TIME',
  );
});

test('sub-hour offset, northern hemisphere: Asia/Kathmandu +05:45 resolves 19:00 to 13:15Z', async () => {
  assert.deepEqual(findLocalStartCandidates('2026-06-15T19:00', 'Asia/Kathmandu'), [
    '2026-06-15T13:15:00.000Z',
  ]);
  const result = await attempt('Asia/Kathmandu', '2026-06-15T19:00');
  assert.deepEqual(result, { status: 201, code: null, startUtc: '2026-06-15T13:15:00.000Z' });
});

test('sub-hour offset, southern hemisphere: Australia/Eucla +08:45 resolves 19:00 to 10:15Z', async () => {
  assert.deepEqual(findLocalStartCandidates('2026-06-15T19:00', 'Australia/Eucla'), [
    '2026-06-15T10:15:00.000Z',
  ]);
  const result = await attempt('Australia/Eucla', '2026-06-15T19:00');
  assert.deepEqual(result, { status: 201, code: null, startUtc: '2026-06-15T10:15:00.000Z' });
});

test(
  'sub-hour offset zone Pacific/Chatham +12:45: 2026-06-01T02:30 resolves by rule to a single instant',
  async () => {
    assert.deepEqual(findLocalStartCandidates('2026-06-01T02:30', 'Pacific/Chatham'), [
      '2026-05-31T13:45:00.000Z',
    ]);
    const result = await attempt('Pacific/Chatham', '2026-06-01T02:30');
    assert.deepEqual(result, { status: 201, code: null, startUtc: '2026-05-31T13:45:00.000Z' });
  },
);

test('sub-hour offset zone Pacific/Chatham: its fall-back overlap is refused without fold', async () => {
  assert.deepEqual(findLocalStartCandidates('2026-04-05T03:30', 'Pacific/Chatham'), [
    '2026-04-04T13:45:00.000Z',
    '2026-04-04T14:45:00.000Z',
  ]);
  assert.deepEqual(await attempt('Pacific/Chatham', '2026-04-05T03:30'), {
    status: 400,
    code: 'AMBIGUOUS_LOCAL_TIME',
    startUtc: null,
  });
  assert.deepEqual(await attempt('Pacific/Chatham', '2026-04-05T03:30', 0), {
    status: 201,
    code: null,
    startUtc: '2026-04-04T13:45:00.000Z',
  });
  assert.deepEqual(await attempt('Pacific/Chatham', '2026-04-05T03:30', 1), {
    status: 201,
    code: null,
    startUtc: '2026-04-04T14:45:00.000Z',
  });
});

test('sub-hour offset zone Pacific/Chatham: its spring-forward gap is refused', async () => {
  assert.deepEqual(findLocalStartCandidates('2026-09-27T02:45', 'Pacific/Chatham'), []);
  assert.deepEqual(await attempt('Pacific/Chatham', '2026-09-27T02:45'), {
    status: 400,
    code: 'INVALID_TIME',
    startUtc: null,
  });
});

test('whole-hour zone Asia/Tokyo +09:00 resolves 19:00 to 10:00Z', async () => {
  const result = await attempt('Asia/Tokyo', '2026-06-15T19:00');
  assert.deepEqual(result, { status: 201, code: null, startUtc: '2026-06-15T10:00:00.000Z' });
});

test('Europe/London spring gap on a whole-hour offset zone', async () => {
  assert.deepEqual(findLocalStartCandidates('2026-03-29T01:30', 'Europe/London'), []);
  assert.deepEqual(await attempt('Europe/London', '2026-03-29T01:30'), {
    status: 400,
    code: 'INVALID_TIME',
    startUtc: null,
  });
});

test('a local start off the 15-minute grid is refused, never rounded', async () => {
  // Kathmandu is on-grid only at :00/:15/:30/:45 of its own offset. 19:07 is real wall
  // time and resolves to 13:22Z, which is not a bookable instant.
  assert.deepEqual(findLocalStartCandidates('2026-06-15T19:07', 'Asia/Kathmandu'), [
    '2026-06-15T13:22:00.000Z',
  ]);
  assert.deepEqual(await attempt('Asia/Kathmandu', '2026-06-15T19:07'), {
    status: 400,
    code: 'INVALID_DURATION',
    startUtc: null,
  });
});

test('a local start carrying an offset is refused instead of being reinterpreted', async () => {
  assert.deepEqual(await attempt('Asia/Tokyo', '2026-06-15T19:00:00Z'), {
    status: 400,
    code: 'INVALID_TIME',
    startUtc: null,
  });
});

test('an impossible calendar date is refused', async () => {
  assert.deepEqual(await attempt('Asia/Tokyo', '2026-02-30T19:00'), {
    status: 400,
    code: 'INVALID_TIME',
    startUtc: null,
  });
});

test('an unknown IANA zone is refused rather than falling back to the host zone', async () => {
  assert.throws(
    () => findLocalStartCandidates('2026-06-15T19:00', 'Mars/Olympus_Mons'),
    (err: { code?: string }) => err.code === 'INVALID_TIMEZONE',
  );
});

test('the ambient process time zone does not participate in resolution', () => {
  const original = process.env.TZ;
  try {
    const results = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata'].map((ambient) => {
      process.env.TZ = ambient;
      return resolveLocalStartInstant('2026-06-15T19:00', 'Asia/Kathmandu');
    });
    assert.deepEqual(results, [
      '2026-06-15T13:15:00.000Z',
      '2026-06-15T13:15:00.000Z',
      '2026-06-15T13:15:00.000Z',
      '2026-06-15T13:15:00.000Z',
    ]);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});