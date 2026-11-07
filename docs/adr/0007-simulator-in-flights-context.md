# 0007. The simulator writes through the Flights context

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The platform needs a steady stream of realistic operational events: boarding, departures, delays, gate changes, diversions. A real airline gets these from an operational feed, for example an airport operational database (AODB) or ACARS messages. Here a simulator produces them. The open question was which code it may use to change flights.

## Decision

- The simulator is treated as an **ingest worker of the Flights bounded context**, like an AODB feed adapter. It changes flights only through `FlightService` in `packages/flights-core`. That is the same command layer the Flights subgraph mutations will use in Phase 2, so every change passes the state machine and produces outbox events.
- It reads gate codes from `airports.gates` directly, read-only. This is an accepted shortcut. The production-shaped alternative is to cache gate data from Airports events or the Airports API.
- Leadership is decided with a Postgres session advisory lock. Only one instance drives flights, replicas wait on standby, and the lock is released automatically if the leader's connection dies.
- Timing rules (`nextLifecycleStep`) are pure functions, shared with the seeder. Seeded data is in exactly the state the simulator would have produced, and catching up after downtime emits events with historical timestamps.
- Randomness is seeded (`SIM_RANDOM_SEED`, `SEED_RANDOM_SEED`), so runs are reproducible for debugging and load tests.

## Consequences

- An ops user's change (Phase 2) and a simulator change on the same flight are serialised by the row lock. The loser re-validates and is skipped, never applied blindly.
- Simplifications to keep in mind: aircraft tail routing and gate occupancy are not modelled, and arrival gates are not assigned.
