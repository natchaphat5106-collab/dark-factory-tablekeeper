# Dark Factory Tablekeeper

**Team:** Dark Factory
**Track:** tablekeeper
**Hackathon:** WeAreDevelopers × BAND

## What this repository contains

A restaurant reservation service built by three AI agents
(Planner, Implementer, Reviewer) working in Band Desktop,
with a human owner who arbitrates and certifies. 

## Stages submitted

**Stage 1 — concurrency core (scored)**

The no-double-booking guarantee is enforced at the store
level: a SQLite UNIQUE constraint on `(table_id, quantum_start_utc)`
inside `BEGIN IMMEDIATE`. Application locks are treated as
performance concerns, never as the guarantee.

## Extra content (not per-spec stages)

- `stage-4/` — a product-surface extra: browser frontend + dev
  proxy. It is not a per-spec stage 4 and does not claim a stage.
- `stage-2/` and `stage-3/` — certified hardening and availability
  modules. Their API surface does not match the spec's stage 2 /
  stage 3 requirements.

## Repository structure
├── README.md
├── FACTORY.md
├── mandates/
│ ├── planner.md
│ ├── implementer.md
│ └── reviewer.md
├── room.json
├── stage-1/ scored: concurrency core
├── stage-2/ availability (not per-spec)
├── stage-3/ hardening (not per-spec)
└── stage-4/ frontend extra (not per-spec)

## How to run stage-1/

```bash
cd stage-1
npm test              # 57 tests, all pass
node src/server.ts    # listens on :3000
What Stage 1 demonstrates

No double-booking under 12-process concurrency
Idempotent replay (same key, same booking)
Cross-timezone handling (Bangkok, Kathmandu +05:45)
Sub-hour offset via a 15-minute quantum
Duration ceiling (720 min)
Restaurant scoping
Honest scope

Stage 1's API path is /v1/bookings, not the spec's
/reservations. Field names and error codes differ.
stage-4/ is product surface only; does not claim a stage.
Stages 2-4 were not re-implemented against the spec.
Verification

57 tests, 20/20 gates
Stage 1 commit: 5678cd8
Integrity: MANIFEST.stage-1.sha256
