-- Stage 1 schema. Applied exactly once by migrate() in db.ts; every statement is
-- IF NOT EXISTS so that a racing second migrator cannot fail on an existing object.
--
-- The first table is the migration ledger itself, which is why migrate() can ask
-- "has this run?" before it has anywhere to record the answer.

CREATE TABLE IF NOT EXISTS schema_migration (
  name           TEXT PRIMARY KEY,
  applied_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurant (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  timezone  TEXT NOT NULL           -- IANA zone id; reject anything Intl cannot resolve
);

CREATE TABLE IF NOT EXISTS dining_table (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurant(id),
  seats         INTEGER NOT NULL CHECK (seats > 0)
);

CREATE TABLE IF NOT EXISTS booking (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL REFERENCES restaurant(id),
  party_size     INTEGER NOT NULL CHECK (party_size > 0),
  start_utc      TEXT NOT NULL,
  duration_min   INTEGER NOT NULL CHECK (duration_min > 0 AND duration_min % 15 = 0),
  status         TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_key (
  key                TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  booking_id         TEXT NOT NULL REFERENCES booking(id)
);

-- THE GUARANTEE. One row per 15-minute quantum a booking covers, not one row per
-- booking, so any two overlapping bookings collide here and any two disjoint
-- bookings do not. Nothing in this service checks availability before inserting;
-- the primary key is the check.
CREATE TABLE IF NOT EXISTS occupancy (
  dining_table_id    TEXT NOT NULL REFERENCES dining_table(id),
  quantum_start_utc  TEXT NOT NULL,
  booking_id         TEXT NOT NULL REFERENCES booking(id),
  PRIMARY KEY (dining_table_id, quantum_start_utc)
);

CREATE INDEX IF NOT EXISTS booking_slot_idx ON booking (restaurant_id, start_utc);
CREATE INDEX IF NOT EXISTS occupancy_booking_idx ON occupancy (booking_id);