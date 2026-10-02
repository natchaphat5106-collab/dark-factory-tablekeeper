# Stage 1 — Booking core and concurrency proof

**Status:** open. Task file: [`TASK.md`](./TASK.md). Owner of everything in `src/` and `test/`: the
Implementer seat. `package.json`, `tsconfig.json`, and this README are the Planner's and are already
in place.

## What this stage is for

Stage 1 exists to retire the one assumption the whole factory rests on: **the service can never
double-book a table**, no matter how many processes write at once, how often a request is retried, or
which time zone the caller is in. Everything in stages 2–4 is built on top of that guarantee, so it is
proved here first, against a real database file, before any feature is added on top.

## Why the shape is what it is

- **Zero runtime dependencies.** `node:sqlite` and `node:test` ship with the runtime. There is no
  Postgres or Docker on this machine, so a design that depends on a database server's range-exclusion
  constraints could not be run, tested, or reviewed here at all.
- **The guarantee lives in the store.** Occupancy is a primary key. Two writers racing for the same
  slot collide in the database, and exactly one insert survives. In-process mutexes and retry loops
  exist only to reduce contention; nothing depends on them for correctness.
- **Types are erased, not compiled.** Node runs the TypeScript directly, so the service is buildable
  and testable with no build step and no toolchain to install.

## Running it

```sh
node --test                  # the full gate
node --test test/concurrency.test.ts
TZ=Pacific/Kiritimati node --test    # the same gate under a hostile ambient time zone
npm install && npx tsc --noEmit      # advisory typecheck, not part of the gate
```