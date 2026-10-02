# Stage 2 — Domain depth and availability search

**Status: placeholder. Not open yet.**

Opens only after stage 1's acceptance commands pass under review. Its task file will be written by the
Planner and published to the room plan surface before any code is written here.

## Scope reserved for this stage

- Availability search: given a restaurant, a date, a party size, and a duration, return the bookable
  slot starts. This is the read side of the stage-1 guarantee and it must never report a slot that the
  write side would refuse.
- Table assignment: choosing which tables cover a party, including the case where one party needs two
  tables. Stage 1 guarantees that a multi-table booking is atomic; this stage decides *which* tables.
- Hours of operation per restaurant, so slots outside service are never offered or accepted.
- Cancellation windows and the guest-facing manage-or-cancel path.

## Explicitly deferred

Authentication, rate limiting, audit logging, the migration CLI, and product packaging are stage 3 and
stage 4. They are not to be started early.