# Stage 3 — Hardening and time-zone breadth

**Status: placeholder. Not open yet.**

Opens only after stage 2's acceptance commands pass under review. Its task file will be written by the
Planner and published to the room plan surface before any code is written here.

## Scope reserved for this stage

- Authentication and per-guest authorization for bookings.
- Rate limiting, with `429` and a retry hint, on the booking and search routes.
- Idempotency enforcement at the edge, so a duplicate is rejected cheaply rather than by a constraint
  violation.
- An audit trail of every state transition on a booking.
- A migration runner usable outside the service process, and a documented upgrade path for an existing
  database file.
- **The full time-zone suite**: the stage-1 zone table widened to every UTC offset in use, both
  daylight-saving directions, southern-hemisphere zones, zones whose offset changed historically, and
  zones with sub-hour offsets. Stage 1 proved the mechanism on representative zones; this stage proves
  it is not a curated list.
- Observability: structured logs carrying the booking id and the resolved UTC instant on every write.

## Explicitly deferred

Product surface and deployment packaging are stage 4.