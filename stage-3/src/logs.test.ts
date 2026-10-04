/**
 * Unit 6 — structured logging.
 *
 * Claims: one parseable JSON object per line; level filtering; child/context merging;
 * and PII (by key and by email shape) never reaching the sink.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, LOG_LEVELS, type LogContext } from './logs.ts';

const FIXED = '2026-10-04T00:00:00.000Z';

function sink(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function parse(line: string): { time: string; level: string; message: string; context: LogContext } {
  return JSON.parse(line) as { time: string; level: string; message: string; context: LogContext };
}

describe('createLogger', () => {
  it('writes one JSON object per line', () => {
    const out = sink();
    const logger = createLogger({ write: out.write, now: () => FIXED });
    logger.info('booking confirmed', { booking_id: 'b-1', start_utc: FIXED });

    assert.equal(out.lines.length, 1);
    const entry = parse(out.lines[0] as string);
    assert.equal(entry.time, FIXED);
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'booking confirmed');
    assert.deepEqual(entry.context, { booking_id: 'b-1', start_utc: FIXED });
  });

  it('filters below the configured level', () => {
    const out = sink();
    const logger = createLogger({ write: out.write, now: () => FIXED });
    logger.debug('hidden');
    logger.info('shown');
    logger.error('also shown');

    assert.deepEqual(
      out.lines.map((line) => parse(line).level),
      ['info', 'error'],
    );
    assert.equal(createLogger({ level: 'debug' }).level, 'debug');
    assert.equal(LOG_LEVELS.error > LOG_LEVELS.warn, true);
  });

  it('merges child context, with the child and the call overriding the parent', () => {
    const out = sink();
    const base = createLogger({ write: out.write, now: () => FIXED, context: { service: 'stage3', region: 'us' } });
    const child = base.child({ request_id: 'r-1', region: 'eu' });
    child.info('handled', { booking_id: 'b-9' });

    assert.deepEqual(parse(out.lines[0] as string).context, {
      service: 'stage3',
      region: 'eu',
      request_id: 'r-1',
      booking_id: 'b-9',
    });
  });

  it('redacts PII keys, including nested ones', () => {
    const out = sink();
    const logger = createLogger({ write: out.write, now: () => FIXED });
    logger.info('guest', {
      email: 'guest@example.com',
      password: 'hunter2',
      authorization: 'Bearer secret',
      api_key: 'key',
      profile: { phone: '555-1234', first_name: 'Ada' },
    });

    const context = parse(out.lines[0] as string).context;
    assert.equal(context.email, '[REDACTED]');
    assert.equal(context.password, '[REDACTED]');
    assert.equal(context.authorization, '[REDACTED]');
    assert.equal(context.api_key, '[REDACTED]');
    assert.deepEqual(context.profile, { phone: '[REDACTED]', first_name: '[REDACTED]' });
  });

  it('honours extra redaction keys and the email shape in messages and values', () => {
    const out = sink();
    const logger = createLogger({ write: out.write, now: () => FIXED, redact: ['loyalty_id'] });
    logger.info('contact guest@example.com about booking', { loyalty_id: 'L-1', note: 'mail me at a@b.co' });

    const entry = parse(out.lines[0] as string);
    assert.equal(entry.message, 'contact [REDACTED_EMAIL] about booking');
    assert.equal((entry.context as LogContext).loyalty_id, '[REDACTED]');
    assert.equal((entry.context as LogContext).note, 'mail me at [REDACTED_EMAIL]');
  });

  it('keeps a multi-line message on a single line', () => {
    const out = sink();
    const logger = createLogger({ write: out.write, now: () => FIXED });
    logger.warn('line one\nline two');

    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0]?.includes('\n'), false);
    assert.equal(parse(out.lines[0] as string).message, 'line one\nline two');
  });

  it('rejects an unknown level', () => {
    assert.throws(() => createLogger({ level: 'verbose' as never }), TypeError);
  });
});
