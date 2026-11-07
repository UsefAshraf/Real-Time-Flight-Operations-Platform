# Real-Time Flight Operations Platform

Flight status, gate changes, delays and passenger notifications, all in real time. The stack is GraphQL Federation, WebSocket subscriptions fanned out over Redis, PostgreSQL with read replicas, and Kubernetes autoscaling, with OpenTelemetry tracing throughout.

> **Status:** Phase 1 (data layer and flight simulator) complete. See [ROADMAP.md](ROADMAP.md) for all phases.

## How events flow today

```
simulator ──► flights-core (FlightService) ──► Postgres: flights.flights + flights.outbox_events
                 state machine, row lock            │  one transaction
                                                    ▼  pg_notify on commit
                                              outbox-relay ──► Redis  PUBLISH flight.events
                                                                      XADD    flight.events.stream
```

See [ADR 0006](docs/adr/0006-transactional-outbox.md) for why events go through an outbox.

## Repository layout

```
apps/
  gateway/                 Hive Gateway: supergraph + subscriptions          :4000
  subgraph-flights/        Flights, status, schedule, gates                  :4001
  subgraph-airports/       Airports, terminals, gates                        :4002
  subgraph-passengers/     Passengers, bookings                              :4003
  subgraph-notifications/  Preferences, watches, inbox                       :4004
  simulator/               Drives the flight lifecycle, injects disruptions  :4010
  outbox-relay/            Publishes committed events to Redis               :4011
  seed/                    Generates airports, fleet, schedule, passengers   (CLI)
packages/
  domain/                  Flight status state machine, value types
  events/                  Versioned event contracts (zod) and Redis channel names
  flights-core/            Lifecycle rules + transactional commands -> outbox
  db/                      Pool, transactions, SQL migrations + runner
  config/                  Validated env config (zod)
  logger/                  Structured JSON logging (pino) with PII redaction
  service-kit/             /health/live, /health/ready, graceful shutdown
  testing/                 Testcontainers helpers and fixtures
infra/docker-compose/      Postgres 16 + Redis 7 for local development
docs/
  adr/                     Architecture Decision Records
  domain-model.md          Entities, state machine, events, roles
```

## Getting started

Requirements: Node 22+, pnpm 10 and Docker. To install pnpm, run `corepack enable pnpm`. On Windows without admin rights, run `corepack enable --install-directory "$env:APPDATA\npm" pnpm` instead.

```bash
pnpm install
pnpm setup        # start Postgres + Redis, run migrations, seed ~6,000 flights and 240k bookings
pnpm dev          # run every service in watch mode
pnpm events:tail  # watch live flight events arrive on Redis
```

To speed up the simulation, set `SIM_SPEED=60` (one simulated minute per real second). [.env.example](.env.example) lists every setting. All of them have defaults that work with the local stack.

Local infrastructure uses host ports **5433** (Postgres) and **6380** (Redis), not the usual defaults. That way it never collides with a Postgres or Redis installed directly on your machine.

Each service exposes:

| Endpoint            | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `GET /health/live`  | Process is up. Never checks dependencies.                             |
| `GET /health/ready` | Dependencies reachable; returns `503` while draining during shutdown. |
| `GET /stats`        | Simulator and outbox relay only: counters for what they have done.    |

## Scripts

| Command                         | What it does                                                          |
| ------------------------------- | --------------------------------------------------------------------- |
| `pnpm setup`                    | `infra:up` + `db:migrate` + `db:seed`                                 |
| `pnpm infra:up` / `infra:down`  | Start/stop Postgres and Redis (`infra:reset` also deletes the data)   |
| `pnpm db:migrate` / `db:status` | Apply / list SQL migrations                                           |
| `pnpm db:seed` / `db:reseed`    | Seed an empty database / replace existing data                        |
| `pnpm db:reset`                 | Drop all schemas and re-migrate (refused in production)               |
| `pnpm events:tail`              | `SUBSCRIBE flight.events` in the Redis container                      |
| `pnpm dev`                      | Watch mode for all services                                           |
| `pnpm build`                    | Build all packages and apps (Turborepo, cached)                       |
| `pnpm test`                     | Vitest; integration tests start throwaway containers (Testcontainers) |
| `pnpm typecheck` / `pnpm lint`  | `tsc --noEmit` / ESLint (strict, type-aware)                          |
| `pnpm verify`                   | Everything CI runs                                                    |

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint (`feat(flights): add gate change mutation`).
- **Pre-commit:** lint-staged runs ESLint and Prettier on staged files.
- **Decisions:** any significant design choice gets an ADR in [docs/adr](docs/adr/README.md).
- **Configuration:** env vars only, validated at startup; a bad config fails fast with every problem listed.
- **Migrations:** plain SQL in [packages/db/migrations](packages/db/migrations). An applied migration is never edited; the runner refuses to continue if one changes.
- **Data ownership:** one Postgres schema per bounded context, with no foreign keys across contexts.
