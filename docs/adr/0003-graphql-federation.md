# 0003. Split the API into federated GraphQL subgraphs

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

Clients (ops dashboard, passenger app, airport display boards) need one API that joins data across bounded contexts: an airport's departures, each flight's passengers, each passenger's notifications. These contexts change at different rates and would be owned by different teams in a real airline.

## Decision

Use **GraphQL Federation v2** with four subgraphs, each owning its data (own database schema) and its part of the graph:

| Subgraph      | Owns                                      |
| ------------- | ----------------------------------------- |
| Airports      | Airport, Terminal, Gate                   |
| Flights       | Flight, status, schedule, gate assignment |
| Passengers    | Passenger, Booking, boarding pass         |
| Notifications | Preferences, FlightWatch, Notification    |

Entities are shared through `@key` (e.g. `Airport @key(fields: "iata")`, `Flight @key(fields: "id")`) and extended by other subgraphs.

## Alternatives considered

- **Single GraphQL monolith:** simplest, but no independent deployment or scaling, and it hides the cross-service problems this project exists to demonstrate.
- **Schema stitching:** gateway-owned glue code; federation keeps ownership in the subgraphs.
- **REST + BFF:** many round trips or a hand-written aggregation layer per client.

## Consequences

- Cross-subgraph queries create N+1 risk at entity resolution, so DataLoader is mandatory (Phase 4).
- Breaking schema changes must be caught in CI by supergraph composition checks (Phase 3).
- A subgraph outage degrades only its fields (partial data plus errors), not the whole API.
