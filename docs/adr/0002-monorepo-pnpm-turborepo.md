# 0002. TypeScript monorepo with pnpm + Turborepo

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The platform has a gateway, four subgraphs, a simulator, workers and a web app. They share domain types (flight status state machine, event contracts), config, logging and health-check code. Separate repos would make cross-service changes slow and versioning shared code painful.

## Decision

- One repository: `apps/*` (deployable services) and `packages/*` (shared libraries).
- **pnpm workspaces** for strict, fast, disk-efficient installs. Packages can only import what they declare.
- **Turborepo** for task orchestration and caching (`build`, `typecheck`, `test`), respecting the dependency graph.
- TypeScript in strict mode, ESM (`NodeNext`), Node 22+.
- Workspace packages export a `@flightops/source` condition pointing at `src/`. Typecheck, lint and the editor resolve source directly, with no build needed. The `build` uses `dist/` like a published package would.

## Alternatives considered

- **Polyrepo:** strong isolation, but cross-cutting changes (e.g. a new event field) need coordinated releases.
- **Nx:** more features (generators, module boundaries) but heavier; Turborepo is enough here.
- **npm/yarn workspaces:** phantom dependencies and slower installs than pnpm.

## Consequences

- Each service still builds into its own Docker image; the monorepo is a development choice, not a deployment one.
- Shared packages must stay small and stable; domain logic that belongs to one subgraph stays in that subgraph.
