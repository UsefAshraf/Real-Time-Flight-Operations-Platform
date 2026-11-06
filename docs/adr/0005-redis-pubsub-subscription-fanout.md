# 0005. Redis pub/sub fan-out for subscriptions (not sticky sessions)

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

We run N gateway instances behind a load balancer. A passenger's WebSocket lands on one instance, but the event they care about (a gate change) is produced by the Flights subgraph or the simulator, unaware of which instance holds that socket.

## Decision

Every gateway instance subscribes to **Redis pub/sub** channels for the topics its connected clients need, and pushes received events to its local sockets. Instances are stateless with respect to routing.

- Channel naming: `flight:{id}`, `airport:{iata}:board`, `user:{id}:notifications`, so instances receive only relevant traffic.
- Pub/sub is fire-and-forget, so events are **also** appended to a capped **Redis Stream**. On reconnect a client sends `lastEventId` and the server replays the gap.
- Events originate from a transactional outbox (Phase 1), so publishing never diverges from committed state.

## Alternatives considered

- **Sticky sessions only:** the LB pins a client to one instance. That alone does not deliver events produced elsewhere, still needs a broadcast mechanism, rebalances poorly with long-lived connections, and loses all sessions on that instance when it dies.
- **Kafka / NATS JetStream:** durable and scalable, but more infrastructure than needed at this scale; Redis is already required for caching and rate limiting. This is the upgrade path if fan-out volume outgrows Redis.
- **Postgres LISTEN/NOTIFY:** no extra component, but payload limits and connection-per-listener costs make it a poor fit for high fan-out.

## Consequences

- Any instance can be killed at any time. Clients reconnect to a healthy one and replay missed events.
- Redis becomes critical for real-time delivery, so its availability and latency must be monitored (Phase 11).
- Load balancers can use plain least-connections without affinity; sticky sessions remain an optional optimisation, which Phase 9 compares.
