# Stage 4 — Product surface and delivery

**Status: placeholder. Not open yet.**

Opens only after stage 3's acceptance commands pass under review. Its task file will be written by the
Planner and published to the room plan surface before any code is written here.

## Scope reserved for this stage

- The diner-facing flow, end to end: find a restaurant, see real availability, book, then manage or
  cancel that booking. Every one of those steps is a consumer of what stages 1–3 already built; this
  stage assembles them and does not add new persistence semantics.
- Restaurant-facing administration of tables and hours.
- Deployment and operations documentation: how to run the service, how to run the gate, how to apply a
  migration, how to back up and restore a database file.

## Explicitly cut from this stage, on purpose

Waitlists, deposits, payments, notifications, loyalty, and third-party channel integrations are **not**
in scope. None of them was requested, and each would pull a new owner of the booking's state — the
single most dangerous thing that can happen to the no-double-booking guarantee. If one is genuinely
needed, it gets its own stage with its own task file and its own owner, rather than arriving here
unplanned.

## The check the whole factory is judged by

With the service running and a populated database, book every table at every slot, then attempt to book
the same tables at the same slots from a second process, with a retried request, across a daylight-saving
transition, and under `TZ` set to a zone that is not the restaurant's. **Zero double-bookings.** Any
result other than zero means the factory failed.