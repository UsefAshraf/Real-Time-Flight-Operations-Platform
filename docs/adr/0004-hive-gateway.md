# 0004. Hive Gateway as the federation gateway

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The gateway must compose a Federation v2 supergraph **and** serve GraphQL subscriptions over WebSockets, because real-time flight updates are the core feature. It also needs auth, depth/cost limits, persisted queries and OpenTelemetry support, and it must run self-hosted at no license cost.

## Decision

Use **Hive Gateway** (The Guild, part of the GraphQL Mesh ecosystem). It is MIT-licensed, supports Federation v2, and supports subscriptions over WebSockets and SSE, with a plugin system (Envelop) for auth, rate limiting and tracing.

## Alternatives considered

- **Apollo Router:** very fast (Rust), but subscription support is part of the GraphOS Enterprise plan, which this project cannot use. _Re-check this before relying on it, since licensing changes over time._
- **Apollo Gateway (`@apollo/gateway`, Node):** in maintenance mode and does not support subscriptions.
- **WunderGraph Cosmo Router:** open source with event-driven federated subscriptions; a strong alternative and the fallback if Hive Gateway falls short.
- **Separate WebSocket service outside the graph:** works, but splits the API in two and gives up typed subscriptions.

## Consequences

- Gateway instances hold long-lived WebSocket connections, which drives the load-balancing (Phase 9) and autoscaling (Phase 12) design.
- Subscription events must reach whichever gateway instance holds the client socket; see [ADR 0005](0005-redis-pubsub-subscription-fanout.md).
