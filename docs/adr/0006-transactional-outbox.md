# 0006. Transactional outbox for domain events

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Every flight change (delay, gate change, cancellation) must update Postgres **and** reach real-time consumers through Redis. Writing to both from application code is a dual write: if the process crashes, or Redis is down, between the two writes, the database and the event stream disagree. Passengers miss a gate change, or get told about one that was rolled back.

## Decision

- Commands in `flights-core` write the state change and its events to `flights.outbox_events` **in the same transaction**. Either both commit or neither does.
- A separate **outbox relay** (`apps/outbox-relay`) reads unpublished rows with `FOR UPDATE SKIP LOCKED`, sends them to Redis in one `MULTI` (Pub/Sub on `flight.events` plus `XADD` to `flight.events.stream` for replay), then marks them published.
- Wake-up is push-based: an `AFTER INSERT ... FOR EACH STATEMENT` trigger calls `pg_notify('flights_outbox')`, which Postgres delivers only on commit. A 1 s poll is the fallback if the LISTEN connection drops.
- Ordering uses an identity `sequence` column. Events from one command share a timestamp, so time cannot order them. Each command holds the flight's row lock, so sequence order is also correct per flight.
- Published rows are deleted after 72 hours.

## Alternatives considered

- **Publish directly after commit:** loses events on crash and makes failures invisible.
- **Change data capture (Debezium + Kafka):** the most robust, but needs a Kafka cluster and connector ops. This is the upgrade path at larger scale.
- **Postgres LISTEN/NOTIFY as the transport:** 8 KB payload limit, no persistence, and every consumer needs a dedicated database connection.

## Consequences

- Delivery is **at-least-once**. If Redis accepts a batch and the commit that marks it fails, the batch is sent again, so consumers must deduplicate by event `id`.
- Several relays can run safely (`SKIP LOCKED`), but strict cross-instance ordering then needs sharding by flight. One relay is enough at this scale.
- Failed publishes stay in the table with `publish_attempts` and `last_error`, which makes problems visible and easy to retry.
