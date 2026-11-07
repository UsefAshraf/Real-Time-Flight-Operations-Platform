-- Flights bounded context (owned by subgraph-flights; the simulator writes through flights-core).
-- Airports are referenced by IATA code only: no foreign keys across contexts, so each schema
-- can move to its own database later without untangling constraints.
CREATE SCHEMA IF NOT EXISTS flights;

CREATE TABLE flights.aircraft (
  registration text PRIMARY KEY,
  type_code    text NOT NULL,
  model        text NOT NULL,
  category     text NOT NULL CHECK (category IN ('REGIONAL', 'NARROWBODY', 'WIDEBODY')),
  seat_count   integer NOT NULL CHECK (seat_count > 0)
);

CREATE TABLE flights.flights (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_number         text NOT NULL CHECK (flight_number ~ '^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$'),
  -- UTC date of the scheduled departure; (flight_number, service_date) identifies an operation.
  service_date          date NOT NULL,
  origin_iata           text NOT NULL CHECK (origin_iata ~ '^[A-Z]{3}$'),
  destination_iata      text NOT NULL CHECK (destination_iata ~ '^[A-Z]{3}$'),
  diverted_to_iata      text CHECK (diverted_to_iata ~ '^[A-Z]{3}$'),
  status                text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN (
                          'SCHEDULED', 'DELAYED', 'BOARDING', 'DEPARTED', 'AIRBORNE',
                          'DIVERTED', 'LANDED', 'ARRIVED', 'CANCELLED')),
  scheduled_departure   timestamptz NOT NULL,
  scheduled_arrival     timestamptz NOT NULL,
  estimated_departure   timestamptz,
  estimated_arrival     timestamptz,
  actual_departure      timestamptz,
  actual_arrival        timestamptz,
  departure_gate        text,
  aircraft_registration text REFERENCES flights.aircraft (registration),
  delay_minutes         integer NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
  delay_reason          text,
  -- Incremented on every write; lets API clients do optimistic concurrency later.
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flight_number, service_date),
  CHECK (origin_iata <> destination_iata),
  CHECK (scheduled_arrival > scheduled_departure)
);

-- Departure / arrival boards: "flights from CAI between T1 and T2".
CREATE INDEX flights_departures_idx ON flights.flights (origin_iata, scheduled_departure);
CREATE INDEX flights_arrivals_idx ON flights.flights (destination_iata, scheduled_arrival);
-- The simulator only ever scans flights that are still in progress.
CREATE INDEX flights_active_idx ON flights.flights (scheduled_departure)
  WHERE status NOT IN ('ARRIVED', 'CANCELLED');

-- Transactional outbox: domain events are written in the same transaction as the state
-- change, then published to Redis by the outbox relay (at-least-once).
CREATE TABLE flights.outbox_events (
  id               uuid PRIMARY KEY,
  aggregate_type   text NOT NULL,
  aggregate_id     uuid NOT NULL,
  event_type       text NOT NULL,
  event_version    integer NOT NULL,
  payload          jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0,
  last_error       text,
  -- Publish order. Events of one command share a timestamp, so time alone cannot order them;
  -- the row lock taken by every command also makes this order correct per flight.
  sequence         bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE INDEX outbox_unpublished_idx ON flights.outbox_events (sequence)
  WHERE published_at IS NULL;
CREATE INDEX outbox_published_idx ON flights.outbox_events (published_at)
  WHERE published_at IS NOT NULL;

-- Wake the relay immediately instead of waiting for its next poll. Statement-level so a bulk
-- insert sends one notification; NOTIFY is delivered only when the transaction commits.
CREATE FUNCTION flights.notify_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('flights_outbox', '');
  RETURN NULL;
END;
$$;

CREATE TRIGGER outbox_events_notify
  AFTER INSERT ON flights.outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION flights.notify_outbox();
