# Stage 1 task file — booking core and concurrency proof

**Owner:** Implementer seat. **Reviewer:** review seat, on completion.
**Plan:** `../plan.md`. **Mandate:** `../mandates/implementer.md`.

Read this file to the end before writing code. Every design decision this unit needs is already made
below. If you find yourself choosing something not settled here, that is the signal to stop and take it
to the Planner — do not decide it quietly inside the diff.

---

## 1. Objective

Deliver a complete, buildable, running HTTP service that can seat a party at a table and **provably
never double-books a table**, under concurrent writers, duplicate request delivery, and daylight-saving
transitions.

This stage is the risk retirement stage for the whole factory. Stages 2–4 are layered on top of it.
Feature breadth is deliberately not the goal here; the guarantee is.

## 2. File scope — yours and only yours

You own every file below and no file outside it.

```
stage-1/src/db.ts            connection, pragmas, transaction helper
stage-1/src/schema.sql       DDL
stage-1/src/timezone.ts      local wall time -> UTC instant, and back
stage-1/src/slots.ts         the 15-minute occupancy quantum grid
stage-1/src/bookings.ts      the booking write path (reserve, cancel, read)
stage-1/src/errors.ts        the error taxonomy and its HTTP mapping
stage-1/src/server.ts        entry point: listen, graceful close
stage-1/src/routes.ts        request parsing, routing, response shaping
stage-1/test/concurrency.test.ts
stage-1/test/idempotency.test.ts
stage-1/test/timezone.test.ts
stage-1/test/atomicity.test.ts
stage-1/test/http.test.ts
```

Already present and **not yours to edit**: `package.json`, `tsconfig.json`, `README.md`, `.gitignore`.
If one of them is wrong for your implementation, report it; do not patch it.

## 3. Settled decisions — do not re-litigate these

**Runtime.** Node 26, ESM, TypeScript with `erasableSyntaxOnly`. No build step. No runtime
dependencies. Use `node:sqlite`, `node:http`, `node:test`, `node:assert`. Do not add a package.

**Database.** SQLite via `node:sqlite`, one database file per test, `:memory:` is not acceptable for
any test that claims concurrency. On every connection: `PRAGMA journal_mode = WAL` and
`PRAGMA busy_timeout = 5000`.

**Transactions.** Every write path runs inside `db.exec("BEGIN IMMEDIATE")` … `COMMIT`, with
`ROLLBACK` in the error path. Use a single try/finally that guarantees the rollback runs.

**The guarantee.** Occupancy is enforced by a primary key, never by application-level locking:

```sql
CREATE TABLE occupancy (
  dining_table_id TEXT NOT NULL REFERENCES dining_table(id),
  quantum_start_utc TEXT NOT NULL,
  booking_id       TEXT NOT NULL REFERENCES booking(id),
  PRIMARY KEY (dining_table_id, quantum_start_utc)
);
```

A booking occupies **one row per 15-minute quantum** it covers, not one row per booking. A 19:00–20:30
booking on a 90-minute slot writes quanta at 19:00, 19:15, … 20:15. This is what makes the primary key
sufficient: two bookings that overlap always share at least one quantum, and two bookings that do not
overlap share none. **Do not key occupancy on the booking's start time alone** — two bookings at 19:00
and 19:30 on a 90-minute slot would both succeed and overlap. That mistake is the specific failure this
stage exists to prevent.

**Instant format.** One canonical string everywhere: `Date.prototype.toISOString()`, i.e.
`YYYY-MM-DDTHH:MM:SS.sssZ`. All persisted and compared instants use it, so lexicographic order equals
chronological order and string equality equals instant equality.

**Idempotency.** `idempotency_key` has a primary key on the key alone. On conflict, compare a
`request_fingerprint` — a stable hash of the normalized request body. Same fingerprint → return the
stored booking with `200`. Different fingerprint on the same key → `409 KEY_REUSED`. This is what makes a
retried request safe rather than a second booking.

**Atomicity.** A booking that spans more than one table writes every table's quanta in **one**
transaction. Any conflict rolls the whole booking back: no occupancy rows, no `booking` row, no
idempotency key.

**Time zones.** A caller sends `local_start` as `"YYYY-MM-DDTHH:MM"` with **no offset**, plus the
restaurant's IANA zone. Resolve it by scanning candidate instants at **15-minute granularity** around
the naive UTC guess and keeping those whose `Intl.DateTimeFormat` round trip reproduces the requested
wall time.

- 0 candidates → the local time does not exist (spring-forward gap) → `400 INVALID_TIME`.
- 1 candidate → unambiguous, use it.
- 2 candidates → ambiguous (fall-back overlap) → `400 AMBIGUOUS_LOCAL_TIME` unless the request
  supplies `fold: 0` (earlier instant) or `fold: 1` (later instant); a `fold` that matches neither
  candidate → `400 INVALID_TIME`.

The 15-minute granularity is not a stylistic choice. Whole-hour scanning silently returns *nothing* for
zones with sub-hour offsets such as `Asia/Kathmandu` (+05:45) and `Pacific/Chatham` (+12:45/+13:45),
so a whole-hour scan produces a plausible-looking bug that only appears in part of the world. Your
`test/timezone.test.ts` must cover at least one sub-hour-offset zone in both hemispheres.

**Process time zone independence.** Nothing in the service may read `process.env.TZ`, the system zone,
or the host's locale for booking logic. Every conversion takes an explicit zone. The full suite must
pass unchanged under `TZ=Pacific/Kiritimati` (UTC+14).

## 4. Data model

```sql
CREATE TABLE restaurant (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  timezone  TEXT NOT NULL           -- IANA zone id; reject anything Intl cannot resolve
);

CREATE TABLE dining_table (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurant(id),
  seats         INTEGER NOT NULL    -- CHECK (seats > 0)
);

CREATE TABLE booking (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL REFERENCES restaurant(id),
  party_size     INTEGER NOT NULL,
  start_utc      TEXT NOT NULL,
  duration_min   INTEGER NOT NULL,  -- multiple of 15
  status         TEXT NOT NULL      -- 'confirmed' | 'cancelled'
  created_at_utc TEXT NOT NULL
);

CREATE TABLE idempotency_key (
  key                TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  booking_id         TEXT NOT NULL REFERENCES booking(id)
);

CREATE INDEX booking_slot_idx ON booking (restaurant_id, start_utc);
```

Constraints: `duration_min` and every `local_start` must land on the 15-minute grid; `duration_min` must
be a positive multiple of 15; `party_size` must be a positive integer; `seats` must satisfy
`party_size <= seats` or the booking is `409 TABLE_TOO_SMALL`.

Migration discipline: DDL lives in `schema.sql` and is applied through one `migrate()` function that
records applied migrations in a `schema_migration` table and is safe to run twice. Do not execute DDL
ad hoc from request handlers.

## 5. HTTP surface

JSON in, JSON out. Errors always take the shape
`{"error": {"code": "<CODE>", "message": "<human readable>", "details": {…}}}`.

| Method | Path | Success | Failures |
| --- | --- | --- | --- |
| `GET` | `/health` | `200 {"status":"ok"}` | — |
| `POST` | `/v1/restaurants` | `201 {"id"}` | `400 INVALID_TIMEZONE` |
| `POST` | `/v1/restaurants/:id/tables` | `201 {"id"}` | `404 NOT_FOUND` |
| `POST` | `/v1/bookings` | `201 {booking}` | see below |
| `GET` | `/v1/bookings/:id` | `200 {booking}` | `404 NOT_FOUND` |
| `DELETE` | `/v1/bookings/:id` | `204` | `404 NOT_FOUND` |

`POST /v1/bookings` request body:

```json
{
  "restaurant_id": "…",
  "table_ids": ["…"],
  "party_size": 4,
  "local_start": "2026-06-15T19:00",
  "duration_min": 90,
  "idempotency_key": "…",
  "fold": 0
}
```

Failure codes for that route, all of them deliberate:

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_TIME` | 400 | local time does not exist, or `fold` matches no candidate |
| `AMBIGUOUS_LOCAL_TIME` | 400 | fall-back overlap with no `fold` supplied |
| `INVALID_TIMEZONE` | 400 | restaurant zone not resolvable by `Intl` |
| `INVALID_PARTY_SIZE` | 400 | not a positive integer |
| `INVALID_DURATION` | 400 | not a positive multiple of 15, or off the grid |
| `INVALID_TABLE` | 400 | table unknown, or not in that restaurant |
| `SLOT_TAKEN` | 409 | at least one requested table is occupied for an overlapping quantum |
| `TABLE_TOO_SMALL` | 409 | `party_size` exceeds `seats` |
| `KEY_REUSED` | 409 | idempotency key reused with a different request |
| `NOT_FOUND` | 404 | restaurant, table, or booking does not exist |
| `BUSY_RETRY_EXHAUSTED` | 503 | `SQLITE_BUSY` survived the retry budget |

`BUSY_RETRY_EXHAUSTED` exists so that a writer losing a contention race reports a retryable condition
instead of an invented success. Map a primary-key violation on `occupancy` to `409 SLOT_TAKEN`; do not
conflate it with other constraint failures.

Cancellation deletes the booking's occupancy rows and marks the booking `cancelled` in one transaction.
A cancelled booking frees its tables for reuse. Deleting an unknown or already-cancelled booking is
`404 NOT_FOUND`, and deleting twice is therefore not a silent success.

## 6. Tests you must write, and what each one must prove

Every test must fail against a plausible broken implementation. A test that cannot fail is a comment.

**`test/concurrency.test.ts`** — the centre of this stage.
- Spawn **at least 12 child processes** (`node:child_process` spawn of a separate `node` process, not
  threads) against **one database file** and one table and one slot, each performing the same booking.
- Assert exactly **one** process receives `201`, the rest receive `409 SLOT_TAKEN`.
- Assert the `occupancy` table holds exactly the expected number of rows — no duplicates, no orphans —
  and that exactly one `booking` row exists.
- Repeat the race at least three times and at a **non-zero offset from a round clock** (e.g. `:07`,
  `:22`, `:37`) so that a whole-hour-granularity bug cannot pass by luck.
- Add a second race where two processes book **two different tables for the same party at the same
  time** and assert both succeed — proving the guarantee rejects a true conflict and does not reject an
  innocent one.

**`test/idempotency.test.ts`** — deliver the identical request **10 times concurrently** with the same
idempotency key. Assert one `booking` row, one occupancy row set, and that every response is either the
original `201` or a `200` replay of the same booking id. Separately, reuse a key with a different body
and assert `409 KEY_REUSED`.

**`test/timezone.test.ts`** — the cases below, each asserting a specific response code and, where
applicable, the exact UTC instant:

| Zone | Local start | Expect |
| --- | --- | --- |
| `America/New_York` | `2026-03-08T02:30` | `400 INVALID_TIME` (gap) |
| `America/New_York` | `2026-11-01T01:30` | `400 AMBIGUOUS_LOCAL_TIME` |
| `America/New_York` | `2026-11-01T01:30` + `fold: 0` | `05:30Z` |
| `America/New_York` | `2026-11-01T01:30` + `fold: 1` | `06:30Z` |
| `Asia/Kathmandu` (+05:45) | `2026-06-15T19:00` | `13:15Z` |
| `Australia/Eucla` (+08:45) | `2026-06-15T19:00` | `10:15Z` |
| `Pacific/Chatham` (+12:45) | `2026-06-01T02:30` | ambiguous or gap, per zone rules — must not silently resolve |
| `Asia/Tokyo` (+09:00) | `2026-06-15T19:00` | `10:00Z` |

**`test/atomicity.test.ts`** — book two tables where one is already occupied. Assert `409`, and assert
the store afterwards contains **no** occupancy rows, **no** booking row, and **no** idempotency key for
that request. Then cancel a confirmed booking and assert its exact quanta become bookable again.

**`test/http.test.ts`** — full request/response coverage of the table in §5 including every failure
code, plus cancellation, plus the error envelope shape, plus that `/health` answers before any other
route. Start the server on an ephemeral port and close it in `after()`; a test that leaks a listener is a
failure.

## 7. Acceptance criteria — the gate

All five must pass. Run them from `stage-1/`. Report the real output, not a paraphrase.

```sh
cd stage-1
node --test                                # every suite above, 0 failures
node --test test/concurrency.test.ts       # the 12-process race: exactly 1 × 201, 11 × 409
node --test test/idempotency.test.ts       # 10 concurrent duplicates: 1 booking
node --test test/timezone.test.ts          # gap, ambiguous, fold, and sub-hour offsets
node --test test/atomicity.test.ts         # multi-table rollback leaves no trace
TZ=Pacific/Kiritimati node --test          # identical result under UTC+14
node --test test/http.test.ts              # every route and every failure code
```

Advisory, not part of the gate, because it needs a network install:

```sh
npm install && npx tsc --noEmit
```

## 8. Definition of done

- [ ] Every command in §7 run, in order, from `stage-1/`, with real output attached.
- [ ] Every file in §2 created; no file outside §2 created or modified.
- [ ] No runtime dependency added to `package.json`.
- [ ] Every failure code in §5 reachable by at least one test.
- [ ] Concurrency proof runs against a real file-backed database in separate OS processes, not threads.
- [ ] The full suite passes with `TZ` set to a hostile ambient zone.
- [ ] Zero secrets, tokens, or personal data anywhere in the diff.

## 9. What is deliberately not in this stage

No availability search, no table assignment, no authentication, no rate limiting, no migrations CLI, no
deployment packaging, no UI. Those are stages 2–4 and their task files will carry their own
decisions. If you find yourself needing one of them to finish this stage, that is a scope error: report
it rather than building it.