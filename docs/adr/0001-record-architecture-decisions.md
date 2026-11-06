# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

This project makes many trade-offs (federation, gateway choice, real-time fan-out, data replication). Without a record, the reasoning is lost and decisions get re-argued.

## Decision

We keep lightweight Architecture Decision Records (Michael Nygard format) in `docs/adr/`, numbered sequentially. An ADR is never edited after acceptance except to mark it superseded.

## Consequences

- Every non-trivial design choice needs a short write-up in the same PR as the change.
- The ADR log doubles as interview material: each one is a "why did you choose X over Y" answer.
