# dark-factory-tablekeeper

A four-stage factory that builds a restaurant reservation service. One room, three seats, four stages.
The factory's product is a service that **must never double-book a table**, under concurrent writers,
duplicate request delivery, and daylight-saving time changes.

## Layout

| Path | Owner | Contents |
| --- | --- | --- |
| `mandates/planner.md` | Planner | How the planning seat behaves, on any track |
| `mandates/implementer.md` | Implementer | How the implementation seat behaves, on any track |
| `mandates/reviewer.md` | Reviewer | How the review seat behaves, on any track |
| `plan.md` | Planner | The active 4-stage plan, seat ownership, stage-1 done criteria |
| `architecture.json` | Planner | The architecture map the plan embeds |
| `docs/` | Planner | Design notes that outlive a single stage |
| `stage-1/` | Implementer | Booking core + concurrency proof — the risk retirement stage |
| `stage-2/` | Implementer | Domain depth and availability search |
| `stage-3/` | Implementer | Hardening: auth, limits, audit, migrations, time-zone suite |
| `stage-4/` | Implementer | Product surface and delivery packaging |

`stage-2/` through `stage-4/` are placeholders until their stage task file is published. A stage is
opened only when the previous stage's acceptance commands pass under review.

## Seats

- **Planner** — writes the plan, the task files, and the acceptance commands. Publishes snapshots to
  the room plan surface. Does not write production code.
- **Implementer** — owns every file under the current `stage-N/`. Writes code, tests, and migrations.
  Runs the acceptance commands and hands off with absolute paths and real output.
- **Reviewer** — reproduces every claim, attacks the guarantee rather than the style, and blocks on a
  named reproduction rather than a preference. Does not edit the files under review.

## The rule that shapes every stage

The no-double-booking guarantee is enforced **in the store**, by a uniqueness constraint on
`(table_id, slot_start_utc)`, applied inside a `BEGIN IMMEDIATE` transaction. Application-level
locks, in-process mutexes, and retry loops are treated as performance concerns, never as the
guarantee. If a stage can be shown to double-book with two processes and one database file, the stage
has failed regardless of how its own tests read.

## Clean-room

`../tablekeeper/` is a pre-existing repository with the same product name. It is reference material
for the problem domain only. **No file from it may be read for implementation or copied.** This is a
clean-room build: the behaviour is specified in the plan and the task files, and written from those.
Reading it does not make the result cleaner, and there is no partial credit for having looked.

## Stage skeleton

`stage-1/` ships with its build configuration and this factory's task file. Production code for any
stage is written by the Implementer, not by the Planner — the `src/` and `test/` directories are
intentionally empty until then.