# Stage 2 — Domain depth and availability search

**Status: open. Stage 1 is closed and certified; this stage is authorised and unimplemented.**

The task file is [`TASK.md`](./TASK.md). It is the contract — read it to the end before writing code, and
treat its acceptance gate as the definition of done. `stage-1/` is closed and immutable: read it, never
write it. Everything this stage creates lives under `stage-2/`.

## Scope reserved for this stage

- Availability search: given a restaurant, a date, a party size, and a duration, return the bookable
  slot starts. This is the read side of the stage-1 guarantee and it must never report a slot that the
  write side would refuse.
- Table assignment: choosing which tables cover a party, including the case where one party needs two
  tables. Stage 1 guarantees that a multi-table booking is atomic; this stage decides *which* tables.
- Hours of operation per restaurant, so slots outside service are never offered or accepted.
- Cancellation windows and the guest-facing manage-or-cancel path — **deferred out of this stage.** Stage 1
  closed with no cancellation window column and no cancellation route, and adding both is a schema change
  against a frozen tree. `TASK.md` does not scope them; they belong to stage 3.

## Explicitly deferred

Authentication, rate limiting, audit logging, the migration CLI, and product packaging are stage 3 and
stage 4. They are not to be started early.