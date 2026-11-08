# Real-Time Flight Operations Platform: Roadmap

Flight status, gate changes, delays and passenger notifications, all in real time.

The plan has 15 phases (0–14). Each phase delivers working features and ends with a clear "done when" test, so there is always something to demo. Rough total time is 12–16 weeks part-time.

## Progress

| Phase | Scope                               | Status      |
| ----- | ----------------------------------- | ----------- |
| 0     | Foundations                         | ✅ Done     |
| 1     | Data layer and flight simulator     | ✅ Done     |
| 2     | Federated subgraphs                 | ⏭️ Next     |
| 3     | Gateway, auth and schema governance | Not started |
| 4     | N+1 elimination with DataLoader     | Not started |
| 5     | Real-time subscriptions             | Not started |
| 6     | Passenger notifications             | Not started |
| 7     | Redis caching and rate limiting     | Not started |
| 8     | PostgreSQL read replicas            | Not started |
| 9     | Load balancing                      | Not started |
| 10    | Frontend apps                       | Not started |
| 11    | Observability                       | Not started |
| 12    | Kubernetes                          | Not started |
| 13    | Load and resilience testing         | Not started |
| 14    | Hardening and portfolio packaging   | Not started |

---

## Target Architecture

```
                 ┌──────────────── Clients ────────────────┐
                 │ Ops Dashboard · Passenger App · FIDS Board│
                 └───────────────┬──────────────────────────┘
                        HTTPS + WSS (graphql-ws)
                 ┌───────────────▼───────────────┐
                 │  NGINX / HAProxy  (L7 LB)      │  health checks, RR / least_conn,
                 └───────┬───────────────┬───────┘  WS upgrade, rate-limit edge
                 ┌───────▼──────┐ ┌──────▼───────┐
                 │ Gateway #1   │ │ Gateway #N   │  Hive Gateway (Federation v2
                 └───────┬──────┘ └──────┬───────┘  + subscriptions), JWT auth
                         │ Redis Pub/Sub fan-out │
   ┌──────────┬──────────┼────────────┬──────────┘
┌──▼─────┐ ┌──▼──────┐ ┌─▼─────────┐ ┌▼──────────────┐
│Flights │ │Airports │ │Passengers │ │Notifications  │  subgraphs (Node/TS)
└──┬─────┘ └──┬──────┘ └─┬─────────┘ └┬──────────────┘
   │          │          │            │  BullMQ workers (email/push/in-app)
┌──▼──────────▼──────────▼────────────▼──┐   ┌──────────────┐
│ PostgreSQL primary ──► read replicas    │   │ Redis        │ cache · pub/sub
└─────────────────────────────────────────┘   │ rate limits  │ · queues
        ▲                                      └──────────────┘
┌───────┴────────┐   OpenTelemetry ──► Tempo/Jaeger · Prometheus ──► Grafana · Loki
│Flight Simulator│   (generates delays, gate changes, cancellations)
└────────────────┘
```

### Tech stack

- **Language and tooling:** TypeScript and Node 22, in a pnpm + Turborepo monorepo.
- **Federation:** Apollo Federation v2 subgraphs. Use **Hive Gateway** (GraphQL Mesh) as the gateway. It is open source and supports federated subscriptions over WebSockets. Apollo Router needs a paid Enterprise license for subscriptions (a trade-off worth raising in interviews).
- **Database:** PostgreSQL 16 with Drizzle or Prisma for queries and migrations.
- **Redis:** Redis 7 for cache, pub/sub and rate limits, plus BullMQ for queues.
- **Frontend:** React + Vite + Apollo Client.

---

## Phase 0: Foundations (Week 1)

**Goal:** a professional repo skeleton before any feature code.

- Monorepo layout: `apps/` (gateway, the 4 subgraphs, simulator, web), `packages/` (shared types, logger, otel, config, eslint).
- Tooling: TypeScript strict mode, ESLint + Prettier, Vitest, Husky + lint-staged, conventional commits.
- CI with GitHub Actions: lint, typecheck, test and build on every PR.
- `docs/adr/` with the first Architecture Decision Records: why federation, why Hive Gateway, why Redis pub/sub.
- Domain model doc covering Flight, FlightLeg, Airport, Gate, Terminal, Aircraft, Passenger, Booking, Notification, Subscription, and a flight status state machine: `SCHEDULED → BOARDING → DEPARTED → AIRBORNE → LANDED → ARRIVED`, plus `DELAYED`, `CANCELLED` and `DIVERTED`.

**Done when:** `pnpm build && pnpm test` passes in CI and the ADRs are committed.

---

## Phase 1: Data Layer and Flight Simulator (Week 2)

**Goal:** realistic data and a live stream of events.

- Docker Compose with Postgres and Redis.
- Schemas and migrations, one database schema per subgraph (`flights.*`, `airports.*`, `passengers.*`, `notifications.*`). Each service owns its own data.
- Seed data: real airports from the public OurAirports dataset (CAI, LHR, JFK, DXB…), synthetic routes, roughly 2,000 flights per day, and about 50k passengers and bookings.
- **Flight Simulator service:** moves flights through the state machine and randomly injects delays, gate changes, cancellations and diversions at a configurable rate.
- **Transactional outbox:** each status change writes the change and an `outbox_events` row in the same transaction. A relay then publishes it to Redis, so no event is ever lost.
- Event contract, versioned:

  ```json
  {
    "id": "uuid",
    "type": "FlightGateChanged",
    "version": 1,
    "flightId": "...",
    "occurredAt": "...",
    "payload": { "oldGate": "A12", "newGate": "B04" }
  }
  ```

**Done when:** the simulator runs and events stream with `redis-cli SUBSCRIBE flight.events`.

---

## Phase 2: Federated Subgraphs (Weeks 3–4)

**Goal:** four independent GraphQL services.

| Subgraph          | Owns                                              | Key federation features                                  |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------- |
| **Airports**      | Airport, Terminal, Gate, weather stub             | `@key(fields: "iata")`                                   |
| **Flights**       | Flight, status, times, gate assignment, aircraft  | Extends `Airport` with `departures` / `arrivals`         |
| **Passengers**    | Passenger, Booking, boarding pass                 | Extends `Flight` with `passengers`, `Passenger.bookings` |
| **Notifications** | NotificationPreference, Notification, FlightWatch | Extends `Passenger` with `notifications`                 |

- Entity resolution through `__resolveReference`, plus `@external`, `@requires`, `@provides` and `@shareable` where they make sense.
- Relay-style cursor pagination and filtering (`flights(airport: "CAI", status: DELAYED, date: ...)`).
- Mutations, ops role only: `delayFlight`, `changeGate`, `cancelFlight`, `assignAircraft`, all validated by the state machine.
- Typed errors (`FlightNotFound`, `InvalidTransition`) via union result types.
- GraphQL Code Generator for typed resolvers.
- Unit tests for resolvers and integration tests per subgraph using Testcontainers.

**Done when:** each subgraph runs on its own and passes composition checks.

---

## Phase 3: Gateway, Auth and Schema Governance (Week 5)

**Goal:** one unified API.

- Hive Gateway with a composed supergraph, generated in CI by `mesh-compose` or `rover supergraph compose`.
- **CI schema checks:** a breaking change in any subgraph fails the build.
- **Auth:** JWT validated at the gateway, with claims (`sub`, `role`: passenger / ops / admin) forwarded to subgraphs in headers. Field-level authorization with `@authenticated` / `@requiresScopes`, for example only ops can see `Passenger.passportNumber`.
- Security limits: query depth, query complexity/cost, and persisted queries (APQ).
- Error masking in production and a correlation ID on every request.

**Done when:** one query from the browser joins Airport → departures → passengers → notifications across all four services.

---

## Phase 4: N+1 Elimination with DataLoader (Week 6)

**Goal:** prove the performance gains with numbers.

- First, measure the baseline: log SQL query counts for `airport { departures(first: 100) { passengers { bookings } } }`. Expect hundreds of queries.
- Add per-request DataLoaders in every subgraph (batch by IDs, cache per request, created in the context).
- Batch federation entity resolution too (`__resolveReference` → DataLoader).
- Indexes chosen from `EXPLAIN ANALYZE`, using composite indexes such as `(departure_airport, scheduled_departure)`.
- **Record the before/after numbers**, for example "312 SQL queries → 4, p95 from 840 ms → 45 ms".

**Done when:** a test asserts the maximum number of SQL queries per operation.

---

## Phase 5: Real-Time Subscriptions (Weeks 7–8): the core feature

**Goal:** live updates that work with many gateway instances.

- Subscriptions: `flightUpdated(flightId)`, `airportBoard(iata)`, `gateChanged(airport)`, `myNotifications`.
- Transport: `graphql-ws` over WebSocket, with SSE as a fallback.
- **The multi-instance problem:** a client connected to Gateway #2 must receive events produced anywhere.
  - **Option A, sticky sessions:** the LB pins clients to one instance. Simple, but rebalancing is poor and connections are lost when an instance dies.
  - **Option B, Redis pub/sub fan-out:** every instance subscribes to Redis channels and pushes to its local sockets. Stateless and scales horizontally. ✅ Chosen; document the trade-off in an ADR.
- Channel design: `flight:{id}`, `airport:{iata}:board`, `user:{id}:notifications`, so each instance only receives what its clients need.
- Connection lifecycle: authenticate on `connection_init`, heartbeat/ping, server-side idle timeout, and per-user connection limits.
- **Resilience:** on reconnect the client sends `lastEventId`, and the server replays missed events from a Redis Stream. This closes the gap left by pub/sub's fire-and-forget delivery.
- Backpressure: drop or merge updates for slow consumers (only the latest flight state matters).

**Done when:** with 3 gateway instances and clients on each, a gate change reaches every client in under 200 ms.

---

## Phase 6: Passenger Notifications (Week 9)

**Goal:** a reliable notification pipeline.

- Passengers "watch" flights, automatically for booked flights and manually for any flight.
- Preferences per channel (in-app, email, push) and per event type, with quiet hours.
- Pipeline: flight event → Notifications service → fan-out to affected passengers → **BullMQ** jobs per channel.
- Workers:
  - In-app: Redis pub/sub to `user:{id}`.
  - Email: Nodemailer to **Mailpit** for local testing.
  - Push: Web Push (VAPID).
- Reliability: idempotency keys (`eventId + passengerId + channel`), exponential-backoff retries, a dead-letter queue, and dedupe/collapse ("delayed by 20 min" followed by "delayed by 45 min" becomes one message).
- Templates with i18n (English and Arabic, with RTL support).

**Done when:** cancelling a flight with 300 passengers delivers exactly one notification per passenger per channel, and failures land in the DLQ.

---

## Phase 7: Redis Caching and Rate Limiting (Week 10)

**Caching:**

- Cache-aside for hot reads (airport data, today's departure boards) with a sensible TTL per type.
- **Event-driven invalidation:** a `FlightUpdated` event evicts `flight:{id}` and `airport:{iata}:board`.
- Protection against cache stampedes (request coalescing or lock, plus TTL jitter).
- Gateway response cache for public queries; private data is never cached.

**Rate limiting:**

- Sliding-window limiter as an atomic Redis Lua script, keyed by user, IP and operation.
- Tiers: anonymous < passenger < ops. Expensive queries cost more tokens, based on the complexity score from Phase 3.
- Return `429` with `Retry-After` headers, and limit WebSocket connection attempts.

**Done when:** the dashboard shows cache hit rate above 90% on board queries, and a rate-limit test proves the limits hold.

---

## Phase 8: PostgreSQL Read Replicas (Week 11)

- Primary plus 2 streaming replicas in Compose (Bitnami images, or Patroni for more).
- **Read/write routing:** queries go to replicas, mutations go to the primary, and connections are pooled with **PgBouncer**.
- **Replication lag:** read-your-writes consistency. After a mutation the user's reads go to the primary for N seconds (tracked by a flag in the session or token). Expose lag as a metric.
- Failover drill: kill a replica and confirm queries keep working; document what happens when the primary fails.

**Done when:** load is spread across replicas (verified with `pg_stat_activity`) and the replica-down test passes.

---

## Phase 9: Load Balancing (Week 11, in parallel)

- **NGINX** config: `upstream` with round-robin / `least_conn` / `ip_hash`, WebSocket upgrade headers, `proxy_read_timeout` for long-lived sockets, passive health checks.
- **HAProxy** alternative: active health checks (`/health/ready`), `balance leastconn`, stats page, connection draining.
- Health endpoints on every service: `/health/live` (process up) and `/health/ready` (DB, Redis and subgraphs reachable).
- **Experiment:** compare round-robin and least-connections under WebSocket-heavy load. Long-lived connections make round-robin uneven.
- Graceful shutdown: on SIGTERM, stop accepting connections, send WebSocket close code `1012`, clients reconnect elsewhere, and replay fills any gap.

**Done when:** killing one gateway during load causes clients to reconnect with no events lost.

---

## Phase 10: Frontend Apps (Weeks 12–13)

- **FIDS board** (airport departure/arrival screen): live-updating via the `airportBoard` subscription, with animations for status changes.
- **Ops Dashboard:** flight table with filters, actions to delay, change gate or cancel, a live event feed, and a map of airborne flights (Leaflet).
- **Passenger App:** my bookings, flight watch, notification inbox, push opt-in.
- Apollo Client cache normalization, optimistic UI for ops actions, and a connection-status indicator.
- Playwright E2E test: an ops user changes a gate and the passenger screen updates.

---

## Phase 11: Observability (Week 13)

- **OpenTelemetry** in every service, with trace context propagated through gateway → subgraphs → Postgres/Redis → **across pub/sub and BullMQ** (trace context carried inside the event). One trace follows a gate change from mutation to the passenger's notification.
- **Prometheus metrics:**
  - RED metrics per operation (rate, errors, duration).
  - Active WebSocket connections per instance.
  - Event delivery latency (event created → client received).
  - Cache hit ratio, DB pool usage, replication lag, queue depth, DLQ size.
- **Grafana dashboards:** API overview, real-time pipeline, DB, notifications. Stored as code (JSON in the repo).
- **Logs:** structured JSON logs (pino) into Loki, linked to traces by trace ID.
- **SLOs and alerts:** for example 99.9% availability, p95 below 150 ms, event delivery p99 under 1 s, with Alertmanager rules.

---

## Phase 12: Kubernetes (Week 14)

- Local cluster with **k3d** or **kind**. Helm chart for each service, with values for dev and prod.
- **ingress-nginx** with WebSocket annotations and TLS from cert-manager (self-signed locally).
- **HPA:**
  - Subgraphs scale on CPU.
  - Gateways scale on a **custom metric (active WebSocket connections)** via prometheus-adapter.
- Readiness/liveness probes, PodDisruptionBudgets, resource requests/limits, and a `preStop` hook so WebSocket connections drain before shutdown.
- ConfigMaps and Secrets (Sealed Secrets or External Secrets as a bonus).
- Postgres via the CloudNativePG operator with replicas, and Redis via Helm.
- GitOps bonus: ArgoCD syncing from the repo.

**Done when:** during a k6 run the HPA scales gateways from 2 to 6 pods, then back down, without dropping events.

---

## Phase 13: Load and Resilience Testing (Week 15)

**k6 scenarios:**

1. **Read-heavy:** board queries ramping to peak traffic.
2. **Subscription soak:** 10k concurrent WebSocket clients for 30 minutes, measuring delivery latency.
3. **Disruption storm:** the simulator cancels 50 flights at once (a weather event), causing a notification spike.
4. **Spike:** traffic jumps 5× in 10 seconds.

**Chaos tests** (manual, or with Chaos Mesh):

- Kill gateway pods.
- Kill a replica.
- Restart Redis.
- Add network latency to one subgraph.

**Results report** in `docs/benchmarks.md`, with Grafana screenshots:

> "Sustained **X req/s** at **p95 Y ms**, **Z k concurrent WebSocket clients**, event delivery p99 **< N ms**, zero lost events when 2 of 4 gateways were killed mid-test."

A smaller k6 smoke test runs in CI to catch performance regressions.

---

## Phase 14: Hardening and Portfolio Packaging (Week 16)

**Security:**

- Dependency scanning (Dependabot, Trivy on images).
- Non-root containers.
- Network policies in Kubernetes.
- CORS/CSRF settings.
- Secrets never stored in the repo.

**Docs:**

- README with the architecture diagram, a 5-minute `docker compose up` quickstart, and a GIF demo.
- ADR index.
- `docs/interview-notes.md` covering the 6 hard problems solved:
  1. Subscriptions across instances
  2. N+1 with federation
  3. Cache invalidation
  4. Replication lag
  5. LB algorithm choice with WebSockets
  6. Autoscaling on connection count

**Optional demo deploy:** a cheap VPS running k3s, or Fly.io.

---

## Suggested Order If Time Is Short

**MVP (about 6 weeks):** Phases 0 → 1 → 2 → 3 → 5 → 9. Federation, live subscriptions across instances, and a load balancer.

**Then add, in this order:** 4 → 7 → 11 → 13 (the numbers and graphs), followed by 6, 8, 10 and 12.

## Repo Structure

```
apps/      gateway · subgraph-flights · subgraph-airports · subgraph-passengers
           subgraph-notifications · notification-worker · simulator · web
packages/  shared-types · events · otel · logger · config · db
infra/     docker-compose/ · nginx/ · haproxy/ · helm/ · k8s/ · grafana/ · prometheus/
tests/     k6/ · e2e/
docs/      adr/ · benchmarks.md · interview-notes.md
```

## Note

Keep the project generic: no real airline names or branding, and fictional airline codes.
