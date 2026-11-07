# Architecture Decision Records

Each significant decision gets one short, immutable record. To change a decision, add a new ADR that supersedes the old one, and do not edit history.

Copy [`template.md`](template.md) to `NNNN-short-title.md` to add one.

| #                                                | Decision                                                      | Status   |
| ------------------------------------------------ | ------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)    | Record architecture decisions                                 | Accepted |
| [0002](0002-monorepo-pnpm-turborepo.md)          | TypeScript monorepo with pnpm + Turborepo                     | Accepted |
| [0003](0003-graphql-federation.md)               | Split the API into federated GraphQL subgraphs                | Accepted |
| [0004](0004-hive-gateway.md)                     | Hive Gateway as the federation gateway                        | Accepted |
| [0005](0005-redis-pubsub-subscription-fanout.md) | Redis pub/sub fan-out for subscriptions (not sticky sessions) | Accepted |
| [0006](0006-transactional-outbox.md)             | Transactional outbox for domain events                        | Accepted |
| [0007](0007-simulator-in-flights-context.md)     | The simulator writes through the Flights context              | Accepted |
