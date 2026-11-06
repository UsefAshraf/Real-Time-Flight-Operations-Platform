# Real-Time Flight Operations Platform

Flight status, gate changes, delays and passenger notifications, all in real time. The stack is GraphQL Federation, WebSocket subscriptions fanned out over Redis, PostgreSQL with read replicas, and Kubernetes autoscaling, with OpenTelemetry tracing throughout.

> **Status:** Phase 0 (foundations) complete. See [ROADMAP.md](ROADMAP.md) for all phases.

## Repository layout

```
apps/
  gateway/                 Hive Gateway: supergraph + subscriptions        :4000
  subgraph-flights/        Flights, status, schedule, gates                :4001
  subgraph-airports/       Airports, terminals, gates                      :4002
  subgraph-passengers/     Passengers, bookings                            :4003
  subgraph-notifications/  Preferences, watches, inbox                     :4004
  simulator/               Generates delays, gate changes, cancellations   :4010
packages/
  domain/                  Flight status state machine, value types
  config/                  Validated env config (zod)
  logger/                  Structured JSON logging (pino) with PII redaction
  service-kit/             /health/live, /health/ready, graceful shutdown
docs/
  adr/                     Architecture Decision Records
  domain-model.md          Entities, state machine, events, roles
```

## Getting started

Requirements: Node 22+ and pnpm 10 (`corepack enable pnpm`, or `corepack enable --install-directory "$env:APPDATA\npm" pnpm` on Windows without admin rights).

```bash
pnpm install
pnpm verify      # format check, lint, typecheck, test, build (same as CI)
pnpm dev         # run every service in watch mode
```

Each service exposes:

| Endpoint            | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `GET /health/live`  | Process is up. Never checks dependencies.                             |
| `GET /health/ready` | Dependencies reachable; returns `503` while draining during shutdown. |

## Scripts

| Command          | What it does                                    |
| ---------------- | ----------------------------------------------- |
| `pnpm build`     | Build all packages and apps (Turborepo, cached) |
| `pnpm dev`       | Watch mode for all services                     |
| `pnpm test`      | Vitest across the workspace                     |
| `pnpm typecheck` | `tsc --noEmit` everywhere                       |
| `pnpm lint`      | ESLint (strict, type-aware)                     |
| `pnpm format`    | Prettier                                        |
| `pnpm verify`    | Everything CI runs                              |

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint (`feat(flights): add gate change mutation`).
- **Pre-commit:** lint-staged runs ESLint and Prettier on staged files.
- **Decisions:** any significant design choice gets an ADR in [docs/adr](docs/adr/README.md).
- **Configuration:** env vars only, validated at startup; a bad config fails fast with every problem listed.
