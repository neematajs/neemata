---
name: use-neemata
description: 'Use when answering questions or writing code for Neemata durable workflows and pubsub: Effect task, workflow and durable (replayed) workflow declarations, execution pools, revisions, the Client and Worker modules, in-memory, PostgreSQL and Redis/Valkey stores, Neem workflow workers, and typed publish/subscribe channels.'
---

# Use Neemata

Neemata provides shared utilities (`common`), Effect application hosting
(`effect`), metrics, Neem worker hosting (`neem`), typed pubsub, durable
workflows, and Vite/Nuxt integration (`vite`, `nuxt`). Applications own their
RPC/HTTP APIs and dependency wiring.

- Workflows are Effect-only: declarations, `Client`, `Worker` and `InMemory`
  come from `@nmtjs/workflows`; stores from `@nmtjs/workflows/postgres` and
  `@nmtjs/workflows/redis`. They require `effect@^4.0.4`.
- Pubsub is Effect-only: it imports from `@nmtjs/pubsub` and
  `@nmtjs/pubsub/RedisBroker`.
- Neem hosts workflows with `@nmtjs/workflows/neem` (runtime declaration and
  planner) and `@nmtjs/workflows/neem/worker` (the worker).
- Hosting an Effect application in Neem uses `@nmtjs/effect`; configuring and
  running Neem itself is covered by the `use-neem` skill.

## References

- [Workflows](references/workflows.md) - tasks, workflow steps, references,
  durable workflows and operation names, handlers, pools, the client,
  workers, schedules, revisions, Redis/Valkey, inspector, Neem integration
  and upgrading from the Promise engine.
- [PostgreSQL](references/postgres.md) - the Effect SQL store, hints,
  transactions, schema generation 7, Drizzle and the migrations from 6 and 4.
- [PubSub](references/pubsub.md) - typed Effect channels, delivery semantics,
  errors and retrying, in-memory and Redis/Valkey brokers.
