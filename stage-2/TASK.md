# Stage 2 — Task file: domain depth and availability search

**Status: OPEN.** Owner ruling 2026-10-02 closed stage 1 as certified and opened this stage.

Every digest, run, and verdict in this stage binds to one tree root:

```
/Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper-frozen-20261002-112146
```

`stage-2/` is a tracked subdirectory of that root. The root is the git toplevel; `stage-2/` is not.
Any handoff must carry the output of `git rev-parse --show-toplevel`, produced in the same command
block as the digest, and the Planner verifies it before the handoff is sent.

---

## 1. What this stage is for

Stage 1 proved the write side cannot double-book: one `201` against eleven `409`s across 12 processes,
with the occupancy primary key as the sole enforcement point and no availability check anywhere in the
write path. That guarantee is settled and this stage does not touch it.

Stage 2 builds the **read side**. A diner asks "when can I book a table for four on Friday?" and the
service answers with slot starts. The risk this stage introduces is new and specific: **the search can
offer a slot the write side would refuse.** That is not a performance problem or a cosmetic mismatch —
it is the guarantee leaking out through a door stage 1 did not have. It is the most fragile assumption
in the stage and it is ordered first for that reason.

The second risk is that availability search becomes a second enforcement point. It must not. The search
reads `occupancy`; it never writes it, and it never decides a booking is allowed. If search and write
disagree about what is bookable, the **write side is right by construction** and search is the bug.

---

## 2. Files this stage creates

All under `stage-2/`. Nothing else is in scope.

| Path | Contents |
| --- | --- |
| `stage-2/package.json` | `"type": "module"`, `"test": "node --test --test-concurrency=1"`, no runtime dependency |
| `stage-2/src/availability.ts` | Slot search and table assignment |
| `stage-2/src/hours.ts` | Hours of operation per restaurant, and slot-to-service-window checks |
| `stage-2/src/availability.test.ts` | Unit and property-level tests for both |
| `stage-2/src/hours.test.ts` | Hours parsing, DST interaction, boundary cases |
| `stage-2/src/parity.test.ts` | The search/write parity proof — see §4, and it is the point of the stage |

`stage-1/` is **closed and immutable**. Do not edit, chmod, unlock, or write anything under it. Do not
create probe files there. If you need to read stage-1 code, read it.

---

## 3. Data model additions

Applied by a `migrate2()` in `stage-2/src/hours.ts` — or extend stage 1's migration ledger rather than
creating a second one. **Decide this once and state your choice in the handoff.** The rule that matters:
one ledger, not two. A second ledger means two answers to "has this run?", and the whole point of the
stage-1 ledger was that it exists so the question can be asked before there is anywhere to record it.

```sql
CREATE TABLE IF NOT EXISTS restaurant_hours (
  restaurant_id TEXT NOT NULL REFERENCES restaurant(id),
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_min     INTEGER NOT NULL CHECK (opens_min >= 0 AND opens_min < 1440),
  closes_min    INTEGER NOT NULL CHECK (closes_min > 0 AND closes_min <= 1440),
  PRIMARY KEY (restaurant_id, weekday)
);
```

`weekday` and `opens_min`/`closes_min` are **local wall-clock minutes in the restaurant's own zone**, not
UTC. Storing them in UTC would make the table unreadable and the DST behaviour wrong. One row per
weekday, so a closed day is simply absent.

---

## 4. Unit 1 — Parity: the search must not offer a slot the write side refuses

**Owner: unassigned. Depends on: nothing. Do this first.**

The exported function:

```ts
export function isSlotBookable(
  db: Db,
  restaurantId: string,
  tableIds: string[],
  startUtc: string,
  durationMin: number,
): boolean
```

`true` means: every one of `tableIds` is at this restaurant, is large enough, and holds no `occupancy`
row for any quantum the booking would cover, and the slot falls inside service hours.

The proof, in `stage-2/src/parity.test.ts`. **One test, and it must fail if the search is wrong:**

1. Build a database with two restaurants, tables of differing seat counts, and a known set of bookings.
2. For **every** combination of table set, party size, duration, and start quantum in the grid, ask
   `isSlotBookable`. Then attempt the real booking through stage 1's `reserve()` with the same inputs.
3. Assert the two agree on exactly one axis: **if `isSlotBookable` returns `true`, `reserve()` must
   succeed. If it returns `false`, `reserve()` must fail with `SLOT_TAKEN`, `INVALID_TABLE`, or
   `TABLE_TOO_SMALL` — never succeed.**
4. The one-directional form is the whole test. A booking succeeding when search says `false` is a stale
   read, which is legitimate — the slot may have been taken a millisecond ago — and the write side
   handles it correctly. A booking succeeding when search says `true` is a defect.

Enumerate the grid in code, not by hand-written cases. A hand-written case list tests the cases you
thought of; an enumerated grid tests the space, and the bug in stage 1's first review was a case nobody
thought of.

**Acceptance:**

```sh
cd /Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper-frozen-20261002-112146/stage-2
npm test -- src/parity.test.ts
```

Passes, and the enumerating loop reports its case count. Then prove the test has teeth by breaking the
search deliberately — invert the `isSlotBookable` return, or drop one `occupancy` predicate — and
confirm `parity.test.ts` fails. **A parity test that passes against a deliberately wrong search is worse
than no test**, because it will be read as proof. Report both runs' real output.

---

## 5. Unit 2 — Hours of operation

**Owner: unassigned. Depends on: nothing — may run in parallel with Unit 1.**

```ts
export function assertWithinHours(db: Db, restaurantId: string, startUtc: string, durationMin: number): void
export function getHours(db: Db, restaurantId: string, weekday: number): { opens: number; closes: number } | null
```

- `assertWithinHours` throws `ApiError('INVALID_TIME', ...)` when the booking starts before opening,
  ends after closing, or the restaurant is closed that weekday.
- **Compute the weekday and the wall-clock minutes in the restaurant's zone, not the caller's.** A
  booking at `2026-10-02T23:00Z` is `2026-10-03T08:00` in Asia/Tokyo and `2026-10-02T19:00` in
  America/New_York, and the two have different answers about both weekday and hours. Reusing
  stage 1's zone resolver is required; do not add a second implementation.
- **`closes_min` past midnight is out of scope.** A restaurant open until 01:00 is one row with
  `closes_min = 1440` plus a next-day row; modelling the crossover belongs to stage 3. Do not
  half-build it. State this limit in a comment so the next seat does not inherit an ambiguous contract.
- Absent `restaurant_hours` for a weekday means **closed**, not open. It is the fail-closed reading, and
  the alternative silently offers every slot at every restaurant with no hours configured.

**Acceptance:**

```sh
cd /Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper-frozen-20261002-112146/stage-2
npm test -- src/hours.test.ts
```

Must cover, each as its own named case: a slot inside hours; a slot starting one minute before opening;
a slot ending one minute after closing; a closed weekday; **the same UTC instant yielding different
answers in two zones at least 12 hours apart**; and a DST transition day where the wall clock repeats.

---

## 6. Unit 3 — Table assignment

**Owner: unassigned. Depends on: Units 1 and 2.**

```ts
export function findTableCombination(
  db: Db, restaurantId: string, partySize: number, startUtc: string, durationMin: number,
): { tableIds: string[]; seats: number } | null
```

- Return `null` when nothing can seat the party. Do not throw `TABLE_TOO_SMALL` from search — search
  reports absence, the write path reports refusal, and conflating them is how a search starts refusing
  writes.
- **A multi-table party is in scope and must be solved correctly.** Party of 6 with only 4-seat tables
  returns two of them. A greedy first-fit is wrong here and will be caught: greedy picks two 4s when a
  6 and a 4 exist that fit one party in two tables with a different leftover shape. Search combinations
  in decreasing seat-sum order so the tightest workable set is returned first.
- **Only tables from the requested restaurant.** `restaurantId` is a required positional argument with
  **no default**, and it appears in the query. This is stage 1's original bug in the form stage 2 first
  gets the chance to reintroduce it, because stage 2 is where a reusable "find bookable tables" query is
  finally written. A helper that takes `restaurantId` as an optional trailing argument with an unscoped
  fallback reproduces the exact defect that cost stage 1 a review round. Every call site passes it.

**Acceptance:**

```sh
cd /Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper-frozen-20261002-112146/stage-2
npm test -- src/availability.test.ts
```

Must cover: single table fits; greedy-would-be-wrong combination returns the tighter set; cross-restaurant
tables are never returned even when they would fit; party larger than any combination returns `null`; and
a table held for a **partial** overlap (booking 19:00–19:45 queried at 19:30) is excluded for the whole
overlapping quantum range, not just the first quantum.

---

## 7. Unit 4 — Slot search endpoint

**Owner: unassigned. Depends on: Units 1, 2, 3.**

`GET /v1/restaurants/:id/availability?local_date=YYYY-MM-DD&party_size=N&duration_min=M`

- Returns `{ slots: [{ start_utc, start_local, table_ids }] }`, ordered by `start_utc`.
- **Read-only. This endpoint writes nothing** — no `occupancy`, no `idempotency_key`, no hold. A search
  that reserves is a search that can double-book, and the hold/deposit concept belongs to a stage that
  has decided on it.
- `local_date` is interpreted in the restaurant's zone.
- Uses stage 1's `createRequestListener` error path, so an unknown restaurant is `404 NOT_FOUND` and a
  bad query is `400 INVALID_PARTY_SIZE` / `INVALID_DURATION` — the codes already in `ERROR_STATUS`. **Do
  not add error codes for this stage.** The taxonomy is enumerable from one map on purpose, and every
  code added here is one stage 3 has to keep reachable by a test.
- Existing routes and their status codes are unchanged. This is additive.

**Acceptance:**

```sh
cd /Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper-frozen-20261002-112146/stage-2
npm test
TZ=Pacific/Kiritimati npm test
```

Both green. The second is not ceremonial: stage 1 established that bare `node --test` fails roughly one
run in five on this machine because parallel suites starve the event loop, which is why
`--test-concurrency=1` is in the test script. **Every command in this file goes through `npm test`,
including the per-file ones — `npm test -- <file>` passes the file to the same serialised runner.** Never
bare `node --test`, never with parallelised files. The serialised full-suite run and `npm test` are the
same command, so they are not listed twice.

---

## 8. Stage-2 acceptance gate

Six commands from `stage-2/`, all must pass, in this order:

```sh
cd /Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper-frozen-20261002-112146/stage-2
npm test                                  # every suite, serialised, 0 failures
npm test -- src/parity.test.ts            # search never offers a slot the write side refuses
npm test -- src/hours.test.ts             # zone-correct weekday and service window
npm test -- src/availability.test.ts      # multi-table assignment, cross-restaurant exclusion
TZ=Pacific/Kiritimati npm test            # identical result at UTC+14
TZ=America/New_York npm test              # identical result on the other side of the date line
```

Plus, all simultaneously true:

- [ ] Every file in §2 created. Nothing outside `stage-2/` created or modified.
- [ ] No runtime dependency added. `node:sqlite`, `node:http`, `node:test` only.
- [ ] `occupancy` has exactly one writer, and it is stage 1's booking path. Grep the diff: no
      `INSERT INTO occupancy`, `UPDATE occupancy`, or `DELETE FROM occupancy` appears in stage-2 source.
- [ ] The parity test fails when the search is deliberately broken (§4).
- [ ] The production retry budget is exercised. Stage 1's suite asserts its race distribution under
      `busyAttempts: 300` while production runs at `DEFAULT_BUSY_ATTEMPTS = 3`, which is why stage 2's
      concurrency assertions must use the **default**, with any raised budget appearing only as a
      separately named case. A suite that overrides a retry count proves behaviour under the override,
      not that the system behaves.
- [ ] `restaurantId` is a required positional argument with no default on every table-resolution
      function, and no call site omits it.
- [ ] `npx tsc --noEmit` is clean (advisory; needs a network install).
- [ ] Reviewer reproduces all six commands independently from a fresh disk read.

---

## 9. Known limitation this stage inherits, and it is not mine to fix

The derivation comments at `stage-1/test/concurrency.test.ts:29-38` and
`stage-1/test/idempotency.test.ts:72-79` cite tails of 186 ms over 240 samples and 254 ms over 480. Those
are not reproducible on this hardware — current-harness sampling peaks far below both — and the sample
counts do not match the committed loops (`DUPLICATE_ROUNDS = 8`). The 1000 ms floor is conservative and
correct; **the justification is not citable.** Stage 1 is closed and those files are immutable, so the
comment cannot be fixed in place. If stage 2 re-derives the floor from its own harness, record the new
measurement here and in the plan, and note that it supersedes the stage-1 comment rather than inheriting
it. Do not cite 186 ms or 254 ms in anything stage 2 writes.

---

## 10. What this stage forecloses

Stated now so a later request does not read as a bug:

- **No holds, deposits, or waitlists.** A slot offered by search can be taken by someone else before you
  book it; that is a correct answer, not a defect. Holds would add a second owner of booking state, which
  is the single change most likely to break the guarantee.
- **No past-midnight closing.** §5 states the limit.
- **No authentication.** Anyone may read availability. Stage 3.
- **No search-side caching or precomputation.** A cache is a second copy of occupancy and goes stale in
  exactly the direction that produces false `true`s. If search gets slow, fix the query; do not cache.