/**
 * Stage 4, Unit 1 — booking UI.
 *
 * Talks to the stage-1 HTTP service through the same-origin dev proxy, so every request
 * is relative and there is no CORS handling here. Only six routes exist and only five are
 * reachable from this page:
 *
 *   POST   /v1/restaurants            -> 201 { id }
 *   POST   /v1/restaurants/:id/tables -> 201 { id }
 *   POST   /v1/bookings               -> 201 booking | 200 booking (idempotent replay)
 *   GET    /v1/bookings/:id           -> 200 booking
 *   DELETE /v1/bookings/:id           -> 204 (no body)
 *
 * There is no availability route. That is a property of the service, not an omission here,
 * so the booking attempt doubles as the availability check: a slot that is taken comes back
 * as SLOT_TAKEN rather than as an empty result set.
 *
 * Errors are branched on `error.code`, never on the status number. The taxonomy maps several
 * codes onto the same status (SLOT_TAKEN and TABLE_TOO_SMALL are both 409), so a status-based
 * branch would tell a diner that a 4-seat table is full when the party is simply too large.
 */

const API = '';

const state = {
  restaurantId: null,
  restaurantTz: null,
  tableId: null,
  tableSeats: null,
  bookingId: null,
  /** Last status read back from the server; a cancelled booking must not stay cancellable. */
  bookingStatus: null,
  /** Fingerprint of the last request we sent, and the key we sent it under. */
  requestFingerprint: null,
  idempotencyKey: null,
  inFlight: false,
};

const $ = (id) => document.getElementById(id);

const CODE_MESSAGES = {
  SLOT_TAKEN: 'That table is already booked for this time. Choose another table or another slot.',
  TABLE_TOO_SMALL: 'This table does not seat that many people. Create a larger table, or lower the party size.',
  KEY_REUSED: 'The same idempotency key was replayed with a different request. Start a fresh booking.',
  INVALID_TIME: 'That start time is not a real local time in the restaurant’s zone.',
  AMBIGUOUS_LOCAL_TIME: 'That local time happens twice on this date (daylight saving). Pick a different time.',
  INVALID_TIMEZONE: 'The server does not recognise that IANA time zone.',
  INVALID_PARTY_SIZE: 'Party size must be a whole number above zero.',
  INVALID_DURATION: 'Duration or start time is out of range — the start must sit on the 15-minute grid.',
  INVALID_TABLE: 'The server rejected the request body.',
  NOT_FOUND: 'The server could not find that record.',
  BUSY_RETRY_EXHAUSTED: 'The booking store was busy. Nothing was booked — use “Retry same request”.',
  INTERNAL: 'The server could not complete the request.',
};

function setStatus(id, message, kind = 'info') {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${kind}`;
  el.classList.toggle('is-empty', message === '');
}

function showRaw(entry) {
  const el = $('api-output');
  const lines = el.textContent === '' ? [] : el.textContent.split('\n\n');
  lines.push(JSON.stringify(entry, null, 2));
  el.textContent = lines.join('\n\n');
}

/**
 * The service sends one envelope for every non-2xx: { error: { code, message, details } }.
 * Anything else that arrives (a proxy 502, an HTML error page) is reported honestly rather
 * than coerced into that shape.
 */
function describeFailure(status, data) {
  const error = data && typeof data === 'object' ? data.error : undefined;
  if (error && typeof error.code === 'string') {
    return {
      code: error.code,
      message: CODE_MESSAGES[error.code] ?? error.message ?? 'The request was refused.',
      detail: error.message,
      retryable: status === 503 || error.code === 'BUSY_RETRY_EXHAUSTED',
    };
  }
  return {
    code: `HTTP_${status}`,
    message: status === 502
      ? 'The dev proxy could not reach the service on port 3000. Is stage-1 running?'
      : `Unexpected response (HTTP ${status}) from the server.`,
    detail: null,
    retryable: false,
  };
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Accept': 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${API}${path}`, opts);
  } catch (cause) {
    return {
      status: 0,
      data: null,
      transport: true,
      failure: {
        code: 'NETWORK',
        message: 'Could not reach the server. Nothing was booked.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      },
    };
  }

  let data = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
  }

  return { status: res.status, data, failure: res.ok ? null : describeFailure(res.status, data) };
}

function logCall(method, path, result) {
  showRaw({ request: `${method} ${path}`, status: result.status, response: result.data ?? null });
}

function setBusy(busy) {
  state.inFlight = busy;
  $('create-restaurant').disabled = busy;
  $('create-table').disabled = busy || state.restaurantId === null;
  $('book-btn').disabled = busy || state.tableId === null;
  $('retry-btn').disabled = busy || state.idempotencyKey === null;
  $('cancel-btn').disabled = busy || state.bookingStatus !== 'confirmed';
  $('refresh-btn').disabled = busy || state.bookingId === null;
}

/* ---------------------------------------------------------------- setup */

function populateTimeZones() {
  const select = $('restaurant-tz');
  let zones;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Bangkok', 'Australia/Sydney'];
  }
  const previous = select.value;
  select.replaceChildren(
    ...zones.map((zone) => {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = zone;
      return option;
    }),
  );
  for (const preferred of [previous, 'Asia/Bangkok', 'UTC']) {
    if (preferred && zones.includes(preferred)) {
      select.value = preferred;
      break;
    }
  }
}

$('create-restaurant').addEventListener('click', async () => {
  setBusy(true);
  setStatus('restaurant-status', 'Creating restaurant…', 'pending');
  try {
    const result = await api('POST', '/v1/restaurants', {
      name: $('restaurant-name').value.trim(),
      timezone: $('restaurant-tz').value,
    });
    logCall('POST', '/v1/restaurants', result);
    if (result.status === 201 && result.data) {
      state.restaurantId = result.data.id;
      state.restaurantTz = $('restaurant-tz').value;
      setStatus('restaurant-status', `Created restaurant in ${state.restaurantTz}.`, 'success');
    } else {
      state.restaurantId = null;
      const failure = result.failure;
      setStatus('restaurant-status', `${failure.code}: ${failure.message}`, 'error');
    }
  } finally {
    setBusy(false);
  }
});

$('create-table').addEventListener('click', async () => {
  if (state.restaurantId === null) return;
  const seats = Number.parseInt($('table-seats').value, 10);
  setBusy(true);
  setStatus('table-status', 'Creating table…', 'pending');
  try {
    const result = await api('POST', `/v1/restaurants/${state.restaurantId}/tables`, { seats });
    logCall('POST', `/v1/restaurants/${state.restaurantId}/tables`, result);
    if (result.status === 201 && result.data) {
      state.tableId = result.data.id;
      state.tableSeats = seats;
      const party = $('party-size');
      party.max = String(seats);
      $('party-hint').textContent = `This table seats ${seats}.`;
      setStatus('table-status', `Created a table seating ${seats}.`, 'success');
    } else {
      state.tableId = null;
      const failure = result.failure;
      setStatus('table-status', `${failure.code}: ${failure.message}`, 'error');
    }
  } finally {
    setBusy(false);
  }
});

/* --------------------------------------------------------------- booking */

function buildRequest() {
  const partySize = Number.parseInt($('party-size').value, 10);
  const durationMin = Number.parseInt($('duration').value, 10);
  return {
    restaurant_id: state.restaurantId,
    table_ids: [state.tableId],
    party_size: partySize,
    local_start: `${$('date').value}T${$('time').value}`,
    duration_min: durationMin,
  };
}

/**
 * The key is bound to the request payload, not to the click. Two consequences that matter:
 * a retry after a transport failure or a 503 replays under the same key and comes back 200
 * with the original booking instead of creating a second one, and any edit to the form
 * changes the fingerprint and therefore mints a fresh key.
 */
function keyFor(request) {
  const fingerprint = JSON.stringify(request);
  if (state.requestFingerprint !== fingerprint) {
    state.requestFingerprint = fingerprint;
    state.idempotencyKey =
      typeof crypto.randomUUID === 'function'
        ? `web-${crypto.randomUUID()}`
        : `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
  return state.idempotencyKey;
}

async function submitBooking() {
  if (state.restaurantId === null || state.tableId === null) return;
  const request = buildRequest();
  const idempotencyKey = keyFor(request);

  setBusy(true);
  setStatus('booking-status', 'Booking…', 'pending');
  try {
    const result = await api('POST', '/v1/bookings', { ...request, idempotency_key: idempotencyKey });
    logCall('POST', '/v1/bookings', result);

    if (result.status === 201 || result.status === 200) {
      state.bookingId = result.data.id;
      const replayed = result.status === 200;
      setStatus(
        'booking-status',
        replayed ? 'Already booked — this request replayed the original booking.' : 'Booked.',
        'success',
      );
      await refreshBooking(replayed ? 'Replay confirmed on the server.' : 'Booking confirmed on the server.');
    } else {
      const failure = result.failure;
      const suffix = failure.detail && failure.detail !== failure.message ? ` (${failure.detail})` : '';
      setStatus('booking-status', `${failure.code}: ${failure.message}${suffix}`, 'error');
      if (!failure.retryable) {
        state.requestFingerprint = null;
        state.idempotencyKey = null;
      }
    }
  } finally {
    setBusy(false);
  }
}

$('booking-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void submitBooking();
});

$('retry-btn').addEventListener('click', () => {
  void submitBooking();
});

/* ---------------------------------------------------------- confirmation */

function renderInZone(isoUtc, timeZone) {
  if (typeof isoUtc !== 'string') return '—';
  const when = new Date(isoUtc);
  if (Number.isNaN(when.getTime())) return isoUtc;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(when);
  } catch {
    return isoUtc;
  }
}

function renderBooking(booking) {
  const rows = [
    ['Booking', booking.id],
    ['Status', booking.status, `status-${booking.status}`],
    ['Party', String(booking.party_size)],
    ['Duration', `${booking.duration_min} min`],
    ['Start (UTC)', booking.start_utc],
  ];
  if (state.restaurantTz !== null) {
    rows.push([`Start (${state.restaurantTz})`, renderInZone(booking.start_utc, state.restaurantTz)]);
  }
  rows.push(['Booked at', booking.created_at_utc]);

  $('booking-summary').replaceChildren(
    ...rows.flatMap(([term, value, className = '']) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dd.className = className;
      return [dt, dd];
    }),
  );
}

async function refreshBooking(message) {
  if (state.bookingId === null) return;
  const result = await api('GET', `/v1/bookings/${state.bookingId}`);
  logCall('GET', `/v1/bookings/${state.bookingId}`, result);
  if (result.status === 200 && result.data) {
    state.bookingStatus = result.data.status;
    renderBooking(result.data);
    setStatus(
      'confirm-status',
      `${message} Status is ${result.data.status}.`,
      result.data.status === 'confirmed' ? 'success' : 'info',
    );
  } else {
    const failure = result.failure;
    setStatus('confirm-status', `${failure.code}: ${failure.message}`, 'error');
  }
}

$('refresh-btn').addEventListener('click', async () => {
  setBusy(true);
  try {
    await refreshBooking('Re-read from the server.');
  } finally {
    setBusy(false);
  }
});

$('cancel-btn').addEventListener('click', async () => {
  if (state.bookingId === null) return;
  setBusy(true);
  setStatus('confirm-status', 'Cancelling…', 'pending');
  try {
    const result = await api('DELETE', `/v1/bookings/${state.bookingId}`);
    logCall('DELETE', `/v1/bookings/${state.bookingId}`, result);
    if (result.status === 204) {
      setStatus('confirm-status', 'Cancelled.', 'success');
      await refreshBooking('Cancellation confirmed on the server.');
    } else {
      const failure = result.failure;
      setStatus('confirm-status', `${failure.code}: ${failure.message}`, 'error');
    }
  } finally {
    setBusy(false);
  }
});

/* ------------------------------------------------------------------ boot */

/** Today in the device's own calendar, not in UTC — toISOString can land a day away. */
function localDateString(daysAhead) {
  const when = new Date();
  when.setDate(when.getDate() + daysAhead);
  const pad = (value) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

populateTimeZones();
$('date').value = localDateString(1);
$('time').value = '19:00';
setBusy(false);