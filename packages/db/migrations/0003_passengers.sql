-- Passengers bounded context (owned by subgraph-passengers).
CREATE SCHEMA IF NOT EXISTS passengers;

CREATE TABLE passengers.passengers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  email           text NOT NULL UNIQUE,
  phone           text,
  -- PII: exposed to OPS/ADMIN roles only and redacted from logs.
  passport_number text,
  nationality     text CHECK (nationality ~ '^[A-Z]{2}$'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passengers.bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Record locator; shared by passengers travelling on the same reservation.
  pnr          text NOT NULL CHECK (pnr ~ '^[A-Z0-9]{6}$'),
  passenger_id uuid NOT NULL REFERENCES passengers.passengers (id) ON DELETE CASCADE,
  -- Flight is owned by the flights context: referenced by id, no cross-schema FK.
  flight_id    uuid NOT NULL,
  seat         text,
  cabin        text NOT NULL CHECK (cabin IN ('ECONOMY', 'BUSINESS', 'FIRST')),
  status       text NOT NULL DEFAULT 'CONFIRMED'
                 CHECK (status IN ('CONFIRMED', 'CHECKED_IN', 'BOARDED', 'CANCELLED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flight_id, passenger_id),
  UNIQUE (flight_id, seat)
);

-- (flight_id, ...) lookups use the unique indexes above.
CREATE INDEX bookings_passenger_idx ON passengers.bookings (passenger_id);
CREATE INDEX bookings_pnr_idx ON passengers.bookings (pnr);
