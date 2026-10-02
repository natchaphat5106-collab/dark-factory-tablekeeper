/**
 * Request parsing, routing, and response shaping.
 *
 * Every non-2xx response leaves here in one envelope:
 *   {"error": {"code": "<CODE>", "message": "<human readable>", "details": {...}}}
 * Nothing else in the service writes a response body, so a caller never has to guess
 * the shape of a failure.
 */

import { randomUUID } from 'node:crypto';
import { ApiError, toErrorResponse } from './errors.ts';
import type { Db, TxOptions } from './db.ts';
import { assertResolvableZone } from './timezone.ts';
import { cancelBooking, getBooking, reserve } from './bookings.ts';

const MAX_BODY_BYTES = 64 * 1024;

type JsonBody = Record<string, unknown>;

/**
 * A body the caller got wrong in a way the taxonomy does not name a code for: unparseable
 * JSON, a missing required field, a field of the wrong JSON type. Reported as
 * INVALID_TABLE — the 400 that is not bound to a specific resource concept — with
 * `details.field` naming the actual offender, so the code never has to carry the reason.
 */
function badBody(field: string, message: string, value: unknown): ApiError {
  return new ApiError('INVALID_TABLE', message, { field, received: describe(value) });
}

function describe(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return String(value);
}

const DRAIN_LIMIT_BYTES = MAX_BODY_BYTES * 16;

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversize: { size: number } | undefined;
    let settled = false;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (oversize !== undefined) {
        // Already refusing this body. Keep reading only so the request can finish and
        // the response can be delivered; nothing more is kept in memory.
        if (size > DRAIN_LIMIT_BYTES) {
          // The caller is not going to stop. There is no response worth delivering to a
          // peer sending this much, so give up on the socket rather than read forever.
          settle(() => reject(badBody('body', `request body exceeds ${MAX_BODY_BYTES} bytes`, size)));
          req.destroy();
        }
        return;
      }
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating, but do not destroy the socket: destroying here kills the
        // connection before the 400 envelope written by the route handler can reach the
        // client, which then reports a transport TypeError instead of a refusal it can
        // read. Draining to 'end' is what lets the answer arrive.
        oversize = { size };
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversize !== undefined) {
        settle(() => reject(badBody('body', `request body exceeds ${MAX_BODY_BYTES} bytes`, oversize!.size)));
        return;
      }
      settle(() => resolve(Buffer.concat(chunks)));
    });
    req.on('error', (err) => settle(() => reject(err)));
    req.on('aborted', () => settle(() => reject(badBody('body', 'request aborted before the body was complete', undefined))));
  });
}

async function parseJsonBody(req: import('node:http').IncomingMessage): Promise<JsonBody> {
  const raw = await readBody(req);
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badBody('body', 'request body must be a JSON object', text.slice(0, 120));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badBody('body', 'request body must be a JSON object', text.slice(0, 120));
  }
  return parsed as JsonBody;
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendNoContent(res: import('node:http').ServerResponse): void {
  res.writeHead(204, { 'content-length': 0 });
  res.end();
}

function createRestaurant(db: Db, body: JsonBody): { status: number; body: unknown } {
  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw badBody('name', 'name must be a non-empty string', name);
  }
  const timezone = assertResolvableZone(body.timezone);
  const id = randomUUID();
  db.prepare('INSERT INTO restaurant (id, name, timezone) VALUES (?, ?, ?)').run(id, name, timezone);
  return { status: 201, body: { id } };
}

function createTable(db: Db, restaurantId: string, body: JsonBody): { status: number; body: unknown } {
  const restaurant = db.prepare('SELECT id FROM restaurant WHERE id = ?').get(restaurantId);
  if (restaurant === undefined) {
    throw new ApiError('NOT_FOUND', 'no such restaurant', { restaurant_id: restaurantId });
  }
  const seats = body.seats;
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats <= 0) {
    throw badBody('seats', 'seats must be a positive integer', seats);
  }
  const id = randomUUID();
  db.prepare('INSERT INTO dining_table (id, restaurant_id, seats) VALUES (?, ?, ?)').run(
    id,
    restaurantId,
    seats,
  );
  return { status: 201, body: { id } };
}

function createBooking(db: Db, body: JsonBody, txOptions: TxOptions): { status: number; body: unknown } {
  const result = reserve(
    db,
    {
      restaurantId: body.restaurant_id as string,
      tableIds: body.table_ids as string[],
      partySize: body.party_size as number,
      localStart: body.local_start as string,
      durationMin: body.duration_min as number,
      idempotencyKey: body.idempotency_key as string | undefined,
      fold: body.fold,
    },
    txOptions,
  );
  return { status: result.replayed ? 200 : 201, body: result.booking };
}

async function dispatch(
  db: Db,
  txOptions: TxOptions,
  method: string,
  pathname: string,
  req: import('node:http').IncomingMessage,
): Promise<{ status: number; body?: unknown; noContent?: boolean }> {
  // /health answers before anything else and touches no state, so a probe never waits
  // on the write lock and never fails because a booking is in flight.
  if (method === 'GET' && pathname === '/health') {
    return { status: 200, body: { status: 'ok' } };
  }

  const segments = pathname.split('/').filter((segment) => segment !== '');

  if (segments.length === 2 && segments[0] === 'v1' && segments[1] === 'restaurants') {
    if (method !== 'POST') throw new ApiError('NOT_FOUND', 'no such route', { method, path: pathname });
    return createRestaurant(db, await parseJsonBody(req));
  }

  if (
    segments.length === 4 &&
    segments[0] === 'v1' &&
    segments[1] === 'restaurants' &&
    segments[3] === 'tables'
  ) {
    if (method !== 'POST') throw new ApiError('NOT_FOUND', 'no such route', { method, path: pathname });
    return createTable(db, segments[2] as string, await parseJsonBody(req));
  }

  if (segments.length === 2 && segments[0] === 'v1' && segments[1] === 'bookings') {
    if (method !== 'POST') throw new ApiError('NOT_FOUND', 'no such route', { method, path: pathname });
    return createBooking(db, await parseJsonBody(req), txOptions);
  }

  if (segments.length === 3 && segments[0] === 'v1' && segments[1] === 'bookings') {
    const bookingId = segments[2] as string;
    if (method === 'GET') return { status: 200, body: getBooking(db, bookingId) };
    if (method === 'DELETE') {
      cancelBooking(db, bookingId, txOptions);
      return { status: 204, noContent: true };
    }
    throw new ApiError('NOT_FOUND', 'no such route', { method, path: pathname });
  }

  throw new ApiError('NOT_FOUND', 'no such route', { method, path: pathname });
}

export function createRequestListener(db: Db, txOptions: TxOptions = {}) {
  return function listener(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const method = req.method ?? 'GET';
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://tablekeeper.invalid').pathname;
    } catch {
      const failure = new ApiError('NOT_FOUND', 'no such route', { method, path: String(req.url) });
      sendJson(res, failure.status, failure.toEnvelope().body);
      return;
    }

    void dispatch(db, txOptions, method, pathname, req)
      .then((result) => {
        if (result.noContent === true) {
          sendNoContent(res);
          return;
        }
        sendJson(res, result.status, result.body);
      })
      .catch((err: unknown) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const failure = toErrorResponse(err);
        sendJson(res, failure.status, failure.body);
      });
  };
}