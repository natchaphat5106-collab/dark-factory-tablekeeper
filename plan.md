# Plan: dark-factory-tablekeeper — reservation service that cannot double-book

## Goal

Build a clean-room OpenTable-like reservation service across four stages, where the service **provably
never double-books a table** under concurrent writers, duplicate request delivery, and daylight-saving
time changes. The guarantee is proved in stage 1 against a real database file before any feature is
built on top of it.

## Mandate — read and understood

**All three mandate files arrived empty (0 bytes)** at
`/Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper/mandates/`. There was nothing to read,
so I authored `planner.md`, `implementer.md`, and `reviewer.md` myself. Each is generic: no
track-specific path, endpoint, field name, table name, or error code appears in any of them, as you
required. **Owner-confirmed and now in force** (2026-10-01): the drafts stand, and they passed the
cross-track test.

What the mandates commit the seats to:

- **Planner** — plans, writes task files, defines acceptance commands, publishes snapshots; never
  writes production code; keeps mandates track-agnostic; names the next seat only at handoff time.
- **Implementer** — owns every file under the current `stage-N/`; writes the failing test first; makes
  no correctness guarantee depend on process isolation, timing, or a retry loop alone; hands off with
  absolute paths and real command output.
- **Reviewer** — attacks the guarantee, not the style; reproduces the author's claims; rejects only
  with a named failing input and a file:line; never edits the files under review.

## Architecture

```arch
{
  "kind": "layered",
  "title": "dark-factory-tablekeeper — stage 1 architecture",
  "layers": [
    {
      "id": "edge",
      "title": "HTTP edge",
      "items": [
        { "id": "http_server", "label": "node:http server", "details": "Ephemeral port, JSON in/out, graceful close" },
        { "id": "idempotency_filter", "label": "Idempotency filter", "details": "Key lookup, fingerprint compare, replay 200 / KEY_REUSED 409" },
        { "id": "error_envelope", "label": "Error envelope", "details": "One shape for every non-2xx; 503 on retry budget exhausted" }
      ]
    },
    {
      "id": "domain",
      "title": "Booking domain",
      "items": [
        { "id": "tz_resolver", "label": "Time-zone resolver", "details": "Local wall time + IANA zone to UTC; 15-min offset scan; 0 candidates = gap, 2 = ambiguous, fold disambiguates" },
        { "id": "slot_grid", "label": "Slot grid", "details": "Expands a booking into the 15-min quanta it covers; duration must be a positive multiple of 15" },
        { "id": "booking_service", "label": "Booking write path", "details": "Reserve, cancel, read. Every write inside BEGIN IMMEDIATE. Multi-table bookings are one transaction" },
        { "id": "availability_search", "label": "Availability search", "details": "Stage 2. Read side of the same guarantee" }
      ]
    },
    {
      "id": "store",
      "title": "Storage — SQLite file, WAL",
      "items": [
        { "id": "sqlite_file", "label": "One database file", "details": "node:sqlite, journal_mode=WAL, busy_timeout=5000" },
        { "id": "occupancy_pk", "label": "occupancy PK (table, quantum)", "details": "THE GUARANTEE. Overlapping bookings share a quantum and collide in the store" },
        { "id": "booking_table", "label": "booking", "details": "confirmed | cancelled, start_utc, duration_min, party_size" },
        { "id": "idempotency_table", "label": "idempotency_key", "details": "PK on key alone; a retry is a replay, not a second booking" },
        { "id": "migration_runner", "label": "Migration runner", "details": "schema_migration ledger, idempotent, no ad hoc DDL from handlers" }
      ]
    },
    {
      "id": "proof",
      "title": "Correctness harness",
      "items": [
        { "id": "race_harness", "label": "Multi-process race", "details": "12+ separate OS processes, one file, one slot: exactly 1 x 201 and 11 x 409" },
        { "id": "duplicate_harness", "label": "Duplicate delivery", "details": "Same key 10x concurrently: one booking, rest replays" },
        { "id": "tz_suite", "label": "DST and offset suite", "details": "Spring gap, fall overlap, fold, sub-hour offsets; passes under hostile ambient TZ" },
        { "id": "atomicity_harness", "label": "Atomicity harness", "details": "Two tables, one taken: zero occupancy rows, zero booking rows, zero key rows" }
      ]
    }
  ],
  "flows": [
    { "from": "http_server", "to": "booking_service", "label": "POST /v1/bookings" },
    { "from": "http_server", "to": "availability_search", "label": "availability query" },
    { "from": "http_server", "to": "error_envelope", "label": "any non-2xx" },
    { "from": "idempotency_filter", "to": "idempotency_table", "label": "lookup by key" },
    { "from": "booking_service", "to": "tz_resolver", "label": "local_start + restaurant zone" },
    { "from": "tz_resolver", "to": "slot_grid", "label": "resolved UTC instant" },
    { "from": "booking_service", "to": "slot_grid", "label": "booking to quantum list" },
    { "from": "slot_grid", "to": "occupancy_pk", "label": "15-min quantum rows" },
    { "from": "booking_service", "to": "occupancy_pk", "label": "INSERT in BEGIN IMMEDIATE" },
    { "from": "booking_service", "to": "booking_table", "label": "insert / mark cancelled" },
    { "from": "migration_runner", "to": "sqlite_file", "label": "apply DDL once" },
    { "from": "race_harness", "to": "booking_service", "label": "identical booking from N processes" },
    { "from": "race_harness", "to": "sqlite_file", "label": "N writers, one file" },
    { "from": "duplicate_harness", "to": "idempotency_filter", "label": "same key 10x" },
    { "from": "tz_suite", "to": "tz_resolver", "label": "gap / ambiguous / sub-hour offset" },
    { "from": "atomicity_harness", "to": "booking_service", "label": "2 tables, 1 occupied" },
    { "from": "availability_search", "to": "occupancy_pk", "label": "read occupancy" }
  ]
}
```

## The four stages

Ordered by **risk retirement, not convenience**. Stage 1 is the fragile assumption and it goes first;
stage 2 is the smallest genuine consumer of stage 1; stage 3 hardens what exists; stage 4 assembles a
product. Nothing is built that does not have a named consumer in the same or an earlier stage.

| Stage | Name | What it retires | Opens when |
| --- | --- | --- | --- |
| 1 | Booking core and concurrency proof | "The store, not the code, prevents double-booking" | now |
| 2 | Domain depth and availability search | "The guarantee survives being read as well as written" | stage 1 passes review |
| 3 | Hardening and time-zone breadth | "It holds under abuse, restarts, and every zone, not a curated few" | stage 2 passes review |
| 4 | Product surface and delivery | "A diner can actually complete the journey" | stage 3 passes review |

### Stage 1 — Booking core and concurrency proof

Task file: `stage-1/TASK.md`. Scope: `src/db.ts`, `src/schema.sql`, `src/timezone.ts`, `src/slots.ts`,
`src/bookings.ts`, `src/errors.ts`, `src/server.ts`, `src/routes.ts`, five test files. No availability,
no auth, no UI.

### Stage 2 — Domain depth and availability search

Placeholder in `stage-2/README.md`. Availability search, table assignment including multi-table
parties, hours of operation, cancellation windows. Task file written at stage open.

### Stage 3 — Hardening and time-zone breadth

Placeholder in `stage-3/README.md`. Auth, rate limits, edge idempotency, audit trail, migration runner,
structured logs, and the widened time-zone suite. Task file written at stage open.

### Stage 4 — Product surface and delivery

Placeholder in `stage-4/README.md`. The end-to-end diner journey, restaurant administration, deployment
and operations documentation. Waitlists, deposits, payments, notifications, and channel integrations are
**cut** — none was requested, and each would add a second owner of booking state.

## Seat ownership

| Seat | Owns | Never touches |
| --- | --- | --- |
| **Planner** | `plan.md`, `architecture.json`, `FACTORY.md`, `mandates/*.md`, every stage's `TASK.md`, the acceptance commands, the room plan snapshots | Any file under a `stage-N/src` or `stage-N/test`; any production code |
| **Implementer** | Every file under the open `stage-N/`; migrations; tests; the acceptance run | `plan.md`, `architecture.json`, `FACTORY.md`, `mandates/*`, any closed stage |
| **Reviewer** | The review verdict, and raising plan-level ordering faults to the Planner | Editing any file under review; shipping a fix themselves |

One owner per piece of state. `occupancy` has exactly one writer — the booking write path — in every
stage. No second unit may add a writer to `occupancy` in any stage, because two writers to the same
value is a conflict, not a parallel task.

## Done criteria for stage 1

The gate is seven commands run from `stage-1/`, in this order, all of which must pass. Detail and the
per-test obligations are in `stage-1/TASK.md` §6–§8.

```sh
cd stage-1
node --test                                # every suite, 0 failures
node --test test/concurrency.test.ts       # 12-process race: exactly 1x201, 11x409, 1 booking row
node --test test/idempotency.test.ts       # 10 concurrent duplicates of one key: 1 booking
node --test test/timezone.test.ts          # DST gap, fall overlap, fold, +05:45 and +08:45 offsets
node --test test/atomicity.test.ts         # 2-table rollback leaves no rows and no key behind
TZ=Pacific/Kiritimati node --test          # identical result with the ambient zone at UTC+14
node --test test/http.test.ts              # every route and every failure code
```

Plus, all simultaneously true:

- [ ] Every file in `stage-1/TASK.md` §2 created; nothing outside it created or modified.
- [ ] No runtime dependency added — `node:sqlite`, `node:http`, `node:test` only.
- [ ] The concurrency proof spawns separate OS processes against one file-backed database, not threads.
- [ ] Every failure code in `TASK.md` §5 is reachable by at least one test.
- [ ] `npm install && npx tsc --noEmit` is clean (advisory; needs a network install).
- [ ] Reviewer reproduces all seven commands independently and finds no claim that survives only on the
      author's machine.

## Invariants that carry into stages 2–4

These were not obvious when the plan was first published. Two of them came out of the stage-1 mutant
experiments, and every later stage's task file inherits them.

1. **The occupancy primary key is the only enforcement point, forever.** No stage may read `occupancy`
   to decide whether a write is allowed. A pre-check ahead of the insert is forbidden even when the
   race test passes, because `BEGIN IMMEDIATE` masks it — which is exactly what the mutant proved.
2. **Every stage that touches `occupancy` must carry a store-level test** that asserts the primary key
   refuses a duplicate `(dining_table_id, quantum_start_utc)` with no transaction and no application
   logic involved, and that the key is not over-broad. A concurrency suite cannot substitute for it.
3. **Write-side serialisation is a pair, and both halves are load-bearing. `BEGIN IMMEDIATE` stays.**
   This corrects an earlier invariant in this plan, which claimed `IMMEDIATE` was not load-bearing and
   that a later stage could safely drop to deferred transactions. That was wrong, and the reviewer's
   mutation testing falsified it. Measured on the stage-1 tree:
   - deferred `BEGIN`, retry loop intact → **49 pass / 0 fail**
   - deferred `BEGIN` **and** `DEFAULT_BUSY_ATTEMPTS = 1` → **2 fail**, including the innocent
     two-table race refusing two bookings that should both succeed
   - `BEGIN IMMEDIATE` intact **and** `DEFAULT_BUSY_ATTEMPTS = 1` → **1 fail**, the 12-process race

   So neither half carries the suite alone. A write transaction must **either** take the write lock up
   front **or** retry on `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`; remove either and the guarantee on
   write ordering fails. `IMMEDIATE` is retained because with deferred transactions correctness starts
   depending on SQLite raising `SQLITE_BUSY_SNAPSHOT` on lock upgrade — an implementation behaviour of
   one storage engine, not a property of the schema. The room's own rule is to enforce at the layer
   that does the dangerous thing, and `IMMEDIATE` removes that single-engine dependency entirely. What
   `IMMEDIATE` buys is availability rather than correctness: with it, contention is a wait on the write
   lock; with deferred, it is an abort after the read, rescued only by the retry budget, and exhausting
   that budget yields `503 BUSY_RETRY_EXHAUSTED` — a correct answer, never a wrong one.
   The deferred-`BEGIN` mutation becomes a **permanent regression check**: it should keep passing, and
   if a future stage adds an availability read inside the write transaction it must be re-run.
4. **Table assignment stays behind the booking write path.** Stage 2 chooses which tables cover a
   party; it does not gain a second writer to `occupancy`. Two writers to the same value is a conflict,
   not a parallel task.
5. **A booking's tables must belong to the booking's restaurant.** Added after the stage-1 review found
   the table lookup keyed on id alone, which let any caller holding a table id squat that table's
   occupancy across restaurants — the owner then got `SLOT_TAKEN` on its own inventory, and a
   cross-tenant error leaked the foreign table's seat count. This is a **data-model** invariant, not
   only a route check: `schema.sql` cannot express "this table's restaurant equals this booking's
   restaurant", so the scoping must appear in every query that resolves a table, and stage 2's
   availability search — which reads `occupancy` and `dining_table` directly — inherits it as a
   read-side correctness requirement, not merely a write-side one.
6. **A booking's duration has a ceiling.** `duration_min` was accepted as any positive multiple of 15
   and expanded to that many inserts inside the single global write transaction, so one small request
   could demand ~100k row writes and block the event loop and the write lock for hundreds of
   milliseconds. Bounded maximum duration is part of the contract from here on, with a rejected-path
   test. Bounding the work one request may demand is not rate limiting and is not deferred to stage 3.

7. **Every accepted duration is pinned twice — by the ceiling and by the grid check.** The stage-1
   review found the ceiling missing while the grid check (`durationMin % 15 !== 0`, `slots.ts:63`) was
   present. A mutation that removes only the ceiling proves nothing about the grid check, and a
   ceiling-only test can pass while the grid check has rotted behind it. The grid check is the one that
   makes a 19:00-versus-19:30 overlap impossible in the first place, so it is pinned separately:
   removing either check must fail a test, and neither fix is accepted on the strength of the other's.
8. **A gate must be reproducible before it can certify anything.** Added after the stage-1 gate failed in
   4 of 6 full-suite runs on an idle machine while every observed race was correct. The cause was a
   meta-assertion that measured scheduler jitter — racer fire spread under parallel test-file execution
   — and held it to a 500 ms bound that tightens as machine load rises, so it fails *more* on a busier
   machine. A test that passes 5 times out of 6 is worse than no test: it trains every later stage to
   re-run until green, which is precisely how a real double-book ships unnoticed. **A stage's gate is
   run 10 consecutive times before that stage is certified, and a bound that cannot distinguish a real
   race from jitter must be replaced rather than retried.** The load-bearing parts of such an
assertion are kept — distinct process ids, and no racer firing before the shared instant — because
    those measure the property rather than the machine.

   **The gate stays the full suite; the runs must report the numbers, not just the verdicts.** The
   reviewer proposed narrowing the ten runs to the two spread-sensitive files as a cost saving. It was
   measured and it does not hold: on this machine the full suite runs in 55.4 s and 63.8 s, while
   `concurrency.test.ts` alone runs in 57.1 s and 57.9 s — *slower* than the whole suite, because when
   run alone it gets the whole machine and its three races serialise, whereas in the full suite that
   file overlaps the four cheap ones. Ten runs of the proposed pair cost about the same as ten of the
   full suite, and they would certify 2 of 5 files while the other 3 get a single run. The cost concern
   is real and grows per stage; the answer is a cheaper gate later, not thinner evidence now. **What is
   adopted from that proposal is the part that is free and strictly better: every race already prints
   its fire spread, so the ten runs must report the distribution of those numbers, not merely that the
   bound held.** A bound sitting near its limit then shows up as a trend before it becomes a red run,
   which turns "run it ten times" from a lottery into a measurement. **A verdict also binds the plan
   snapshot's byte count**, not only the source shasums, because the plan surface moves independently of
   the tree — a reviewer reading the plan is reading whatever revision was current, and naming the byte
   count makes that revision part of what was reviewed.

**The sharper form of the rule, from the reviewer's analysis of the stage-1 defect.** The stage-1 bug
was not "a separate lookup that failed to carry the scope" — there was only one lookup, and it was the
only one in the codebase. It was **a validated subject sitting adjacent to an unvalidated parameter of
the same relationship**: `restaurantId` was checked against `restaurant` at `bookings.ts:169`, and then
`tableId` was resolved at `:184` with no reference to the scope that had just been established. Two
identifiers describing one relationship, where only one of them carries the scope. A rule phrased as
"put the scope in the query" does not catch that on its own, because the query looked complete — it
looked up exactly the row it named. The check is per *identifier*, not per query: wherever two or more
fields jointly determine a relationship, every one of them is in scope for every one of them.

**Consequence for stage 2, recorded now so it is not rediscovered later.** There is no shared
table-resolution helper in stage 1 to leave unscoped — `bookings.ts:184` is a local `prepare` inside
`reserve`, and `bookings.ts` exports only `requestFingerprint`, `reserve`, `getBooking` and
`cancelBooking`, none of which resolves tables. The exposure arrives with stage 2's availability
search, which is the first thing that needs a reusable "find bookable tables for this restaurant"
query. **When that helper is written, `restaurantId` must be a required positional argument with no
default, and every call site must pass it.** A `restaurantId` that can be omitted, defaulting to
"unscoped", is the stage-2 form of the stage-1 bug — and a stage-2 reviewer will have no stage-1 diff to
compare against, so the rule has to arrive with the task file rather than be reconstructed from it.

## Evidence this plan rests on

Probed on this machine before writing the task file, not assumed:

- `mandates/*.md` were all 0 bytes on arrival.
- No Postgres, no Docker, no Go, Rust, or Java. Node 26.7, npm 11.19, Python 3.14, SQLite 3.51. A design
  requiring a database server's range-exclusion constraints could not be run, tested, or reviewed here,
  so the guarantee is expressed as a SQLite primary key instead.
- `node:sqlite` and full-ICU `Intl` both work with zero dependencies; `Temporal` is absent, so DST
  resolution is explicit by necessity.
- **12 child processes racing one file-backed slot returned exactly 1 winner and 1 row, with 0 busy
  retries.** The primary-key-under-`BEGIN IMMEDIATE` design is verified before handoff, not hoped for.
- A **15-minute** offset scan resolves `Asia/Kathmandu` (+05:45) and `Australia/Eucla` (+08:45) and both
  directions of `Pacific/Chatham` DST. The same scan at **whole-hour** granularity returns *nothing* for
  those zones. The task file mandates 15 minutes and requires sub-hour-offset zones in the suite,
  because the whole-hour version is a bug that looks correct in the Americas.
- `node --test` discovers and runs `.ts` files natively, so the service is buildable and testable with no
  build step and no installed toolchain.
- **Mutant experiment, stage 1 (2026-10-01).** The Implementer built the exact wrong implementation this
  plan warned about — an availability pre-check in front of the insert, with the occupancy primary key
  downgraded to a plain index — and **the 12-process race test passed it anyway**. `BEGIN IMMEDIATE`
  serialises writers just as well as the primary key does, so the race could not tell a correct
  implementation from a weaker one. This is now the most important measured fact in the factory: a
  passing concurrency suite is not evidence that the guarantee lives in the store. A store-level test
  was added that refuses a duplicate `(table, quantum)` with no transaction and no application check in
  the way, and the mutant now fails it.
- **Second mutant, stage 1 — and the correction it forced.** Swapping `BEGIN IMMEDIATE` for a deferred
  `BEGIN` passes all 49 tests while the retry loop is intact. The planner initially concluded from this
  that `IMMEDIATE` was a contention optimisation and not the guarantee. The reviewer mutation-tested it
  further and the planner reproduced that work: also setting `DEFAULT_BUSY_ATTEMPTS = 1` produces 2
  failures, and doing that while leaving `IMMEDIATE` in place produces 1. The invariant "the primary key
  alone carries correctness" was **wrong** — write-side serialisation is a pair, and the plan has been
  corrected. Both halves now stay, and `IMMEDIATE` is kept specifically so correctness does not depend
  on one storage engine's lock-upgrade behaviour.
- **Flake measured, not asserted.** On the tree the reviewer bound its second verdict to, the planner ran
  the full suite six times: 53/54, 54/54, 54/54, 54/54, 53/54, 52/54. Observed racer spreads ran from
  21 ms to 4180 ms against a 500 ms bound. Every race in every run still read `1 x 201, 11 x 409,
  6 occupancy rows, 1 booking row, 12 pids` — the guarantee held every single time; the harness's
  assertion about itself did not. A second instance of the same defect sits at
  `test/idempotency.test.ts:211`, which failed in the same reproduction at a 793 ms spread.

## Risks

- **The mandate content you intended was never written.** All three files are 0 bytes; I authored
  replacements from your brief. Earliest observation: you read one and find it says something you did
  not ask for. Then replace the file — nothing downstream depends on my wording, only on the seats
  behaving as described.
- **Stage 1 could pass while the guarantee is still false.** A concurrency test using threads or an
  in-memory database proves nothing about separate processes. Earliest observation: the reviewer sees
  `spawn` absent from `test/concurrency.test.ts`. The task file forbids it by name.
- **Whole-hour time-zone scanning.** The most likely silent failure in this build, because it passes in
  every zone the author happens to live in. Earliest observation: no sub-hour-offset zone in
  `test/timezone.test.ts`.
- **Occupancy keyed on booking start instead of covered quanta.** Two bookings at 19:00 and 19:30 with a
  90-minute slot both succeed and overlap. Earliest observation: a two-table/one-taken atomicity test
  using overlapping non-identical starts.
- **Two writers to `occupancy`.** Any future stage that assigns tables by writing occupancy directly
  breaks atomicity with the booking path. Earliest observation: a stage-2 task file that mentions an
  `occupancy` insert outside `bookings.ts`.
- **No Postgres means no range-exclusion constraint.** Durations are quantised to 15 minutes by design,
  so the primary key is exact rather than approximate. Earliest observation: a request for a duration
  that is not a multiple of 15 — that is `400 INVALID_DURATION`, not a hole in the guarantee.
- **The factory root is not under version control, and the cost is compounding.** No `.git` anywhere
  under `dark-factory-tablekeeper/`. It has now cost twice: `test/concurrency.test.ts` changed at 23:35
  while the Reviewer held it, and during the fix round `src/bookings.ts` and `src/slots.ts` changed again
  while the verdict was being written. Both times the change could not be diffed, only reconstructed —
  and the reconstruction is what produced two wrong inferences from this seat (see below). A verdict
  bound to shasums that no longer describe the tree is worse than no verdict, so **no unit may be
  reviewed while the tree is being edited**: the Implementer signals the tree is settled, and the
  Reviewer names the shasums the verdict covers. That protocol is now required, not optional.
  Owner decision still pending on whether to `git init`. I am not initialising a repository or
  committing anything unasked.
- **The Implementer may run in a different runtime with a different working directory.** Absolute paths
  are in every handoff, and the repository root is stated on each. Earliest observation: an Implementer
  reporting `stage-1/TASK.md` not found; send the absolute path again rather than letting it guess.

## What this plan forecloses

- **Fixed 15-minute granularity.** A restaurant cannot seat a party at 19:07, and no duration that is
  not a multiple of 15 minutes is accepted. Correctness was chosen over flexibility. Revisiting it means
  replacing the quantum, not extending the table.
- **Ambiguous local times are refused by default.** A caller booking 2026-11-01T01:30 in New York gets
  `400` unless they send `fold: 0` or `fold: 1`. Guessing would have silently shifted bookings by an
  hour; a client that cannot express the ambiguity cannot use fall-back evenings without a change.
- **Stages are strictly serial.** No stage 2 work starts until stage 1 passes review. In exchange,
  exactly one seat ever writes `occupancy` at a time. If parallel feature work is ever wanted, that is a
  different plan and this guarantee is what gets renegotiated first.
- **The reference repository at `../tablekeeper/` is off limits for reading.** It is clean-room; reading
  it does not make the result cleaner and there is no partial credit for having looked.
- **A second owner of booking state is the one change most likely to break the guarantee.** If waitlist,
  deposits, or payments are ever wanted, each becomes its own stage with its own owner rather than a
  feature in stage 4.

## Decisions taken — owner-confirmed, no longer open

All four questions put to the owner on 2026-10-01 were answered, and the answers are now settled
decisions rather than recommendations. Nothing below is open any more.

1. **The mandates stay as drafted.** The owner's own drafts were never written to disk, so the
   Planner-authored replacements stand. They were checked against the cross-track test and passed: no
   track-specific path, field name, endpoint, or error code appears in any of them.
2. **SQLite over Postgres, permanently.** Postgres will not be installed. The occupancy primary key and
   the 15-minute quantum stay, and the alternative of an exclusion constraint on a time range is closed
   rather than deferred.
3. **`stage-1/` is a buildable skeleton plus `TASK.md`.** The Planner owns structure and build
   configuration and writes no production code; the Implementer writes the code and runs the acceptance
   commands. The Planner does not finish stage 1, and the Implementer is not given a different stage to
   compensate.
4. **Repository root is `/Users/natchaphat5106gmail.com/Desktop/dark-factory-tablekeeper/`.** One tree,
   all three seats. Two copies of a factory is one guarantee too many.

Also confirmed by the owner: `../tablekeeper/` is off limits. No file from it is to be read or copied —
the clean-room condition is a rule of the factory, not a suggestion.

## Open question

1. **Should the factory be under version control?** There is no `.git` anywhere under
   `dark-factory-tablekeeper/`. It already cost us once: a file changed mid-review and the change could
   not be diffed, only reconstructed. Recommendation: yes — initialise a repository at the factory root
   and commit `FACTORY.md`, `plan.md`, `architecture.json`, `mandates/`, and each stage directory at its
   gate, so every review has a baseline to diff against and no seat can quietly rewrite history. Reason:
   the Reviewer seat's entire value is comparing an author's claim against the code, and without a
   baseline "what changed" is a matter of recollection. The distinction is sharper than tidiness: the
   Reviewer's two mid-review reconstructions were recoverable only because the mutated copies happened
   to still be on disk. A change with no diff and no kept copy has no recovery path at all, so a commit
   at each gate is what makes a reconstructed review reconstructable rather than merely neat. I have not
   run `git init` or committed anything, because that is not mine to do unasked. If you decline, the
   fallback is that every handoff states the file modification times it was written against.

## Status

- **Stage 1 — REVIEW FAILED, second verdict. Not approved. Fix round 2 in progress.** The three earlier
  blockers are confirmed fixed and each now has a test: restaurant scoping, the duration ceiling, and the
  body limit. All six of the reviewer's concerns are clear on the settled tree. The remaining blocker is
  the gate itself being non-reproducible.
- **Stage 1 — first verdict. Fix round 1 closed.** The Reviewer returned a failing
  verdict on 2026-10-01: a table lookup in the write path was not scoped to the booking's restaurant,
  so any caller holding a table id could squat that table's occupancy and deny the owning restaurant
  access to its own inventory. `201` where the contract says `400 INVALID_TABLE`. The Planner confirmed
  all four findings against the tree independently before acting. Ordering was judged correct; the
  defects are in the unit, not the sequence.
- **The concurrency and time-zone guarantees were confirmed clean.** The reviewer's mutation testing
  found every plausible broken implementation caught: quantum keying removed → 9 failures, whole-hour
  offset scan → 6 failures, idempotency key not durable → 4 failures, `COMMIT` instead of `ROLLBACK`
  → 2 failures. The primary key is the sole enforcement point, there is no read-then-write pre-check,
  and the resolver is genuinely 15-minute granular with sub-hour-offset zones in both hemispheres.
- **Stages 2–4 — not open.** Their task files are written when their stage opens, not in advance.
- **Plan change log.** Revision 2 records the owner's four rulings and moves them out of open questions.
  Revision 3 adds the stage-1 mutant results, promotes them to invariants that stages 2–4 inherit, and
  records the missing version control as a risk. **Revision 4 corrects an invariant this plan got
  wrong**: "the primary key alone carries correctness, and `BEGIN IMMEDIATE` is only a contention
  optimisation" was falsified by mutation testing and has been replaced with the pair rule. The
  reviewer predicted it would and the planner had published it as settled; a plan that states a
  conclusion before measuring it gets it wrong, and this one did. Also records the settled-tree review
  protocol, after a verdict was bound to shasums that stopped matching mid-review.
  **Revision 5** records the measured gate flake as invariant 8 and sets the certification bar: a
  stage's gate runs 10 consecutive times before that stage is certified, and the reviewer must see all
  ten totals rather than one green run. **Revision 6** takes the reviewer's sharper form of invariant
  5's rule — a validated subject adjacent to an unvalidated parameter of the same relationship, checked
  per identifier rather than per query — records that stage 1 has no shared table-resolution helper to
  leave unscoped, and writes the stage-2 requirement down: `restaurantId` is a required positional
  argument with no default. It also adds invariant 7, pinning the duration ceiling and the 15-minute
  grid check separately, because a ceiling-only mutation leaves the grid check untested and the grid
  check is what makes 19:00-versus-19:30 impossible. **Revision 7** sharpens the open version-control
  question with the reviewer's observation: its two mid-review reconstructions were recoverable only
  because the mutated copies were still on disk, so a commit at each gate is what makes a reconstructed
  review reconstructable rather than merely tidy. No design decision changes; the stage-1 schema, the
  15-minute quantum, and the seven-command gate are unchanged throughout. **Revision 8** records the
  measurement that rejected narrowing the ten certification runs to the two spread-sensitive files —
  `concurrency.test.ts` alone is slower than the full suite, so the saving was not real — while adopting
  the reviewer's two better proposals unchanged: the ten runs must report the fire-spread distribution
  rather than only pass or fail, and a verdict binds the plan snapshot's byte count as well as the source
  shasums, since the plan surface moves independently of the tree. The ten full-suite runs stand.