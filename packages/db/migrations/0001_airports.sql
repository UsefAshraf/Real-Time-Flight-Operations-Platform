-- Airports bounded context (owned by subgraph-airports).
CREATE SCHEMA IF NOT EXISTS airports;

CREATE TABLE airports.airports (
  iata         text PRIMARY KEY CHECK (iata ~ '^[A-Z]{3}$'),
  icao         text UNIQUE CHECK (icao ~ '^[A-Z]{4}$'),
  name         text NOT NULL,
  city         text NOT NULL,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  timezone     text NOT NULL,
  latitude     double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude    double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE airports.terminals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_iata text NOT NULL REFERENCES airports.airports (iata) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  UNIQUE (airport_iata, code)
);

CREATE TABLE airports.gates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id  uuid NOT NULL REFERENCES airports.terminals (id) ON DELETE CASCADE,
  -- Denormalised so "gates at CAI" needs no join; gate codes are unique per airport.
  airport_iata text NOT NULL REFERENCES airports.airports (iata) ON DELETE CASCADE,
  code         text NOT NULL,
  is_open      boolean NOT NULL DEFAULT true,
  UNIQUE (airport_iata, code)
);

CREATE INDEX gates_terminal_idx ON airports.gates (terminal_id);
