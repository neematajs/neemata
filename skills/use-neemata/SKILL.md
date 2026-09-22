---
name: use-neemata
description: 'Use when answering questions or writing code for Neemata durable workflows and pubsub: task and workflow contracts, implementations, execution pools, PostgreSQL and Redis/Valkey runtimes, the runtime client, Neem workflow workers, and typed publish/subscribe channels, with or without Effect.'
---

# Use Neemata

Neemata provides shared utilities (`common`), Effect application hosting
(`effect`), metrics, Neem worker hosting (`neem`), typed pubsub, durable
workflows, and Vite/Nuxt integration (`vite`, `nuxt`). Applications own their
RPC/HTTP APIs and dependency wiring.

- Workflows without Effect import from `@nmtjs/workflows`; Effect applications
  import the contract and implementation builders from `@nmtjs/workflows/effect`.
- Pubsub imports from `@nmtjs/pubsub`, `@nmtjs/pubsub/redis` and
  `@nmtjs/pubsub/effect`.
- Neem workers import from `@nmtjs/workflows/neem` or
  `@nmtjs/workflows/effect/neem`.
- Effect adapters require the optional `effect` peer exactly
  `4.0.0-rc.116`. Core workflow and pubsub APIs are Effect-free.
- Hosting an Effect application in Neem uses `@nmtjs/effect`; configuring and
  running Neem itself is covered by the `use-neem` skill.

## References

- [Workflows](references/workflows.md) - contracts, implementations, pools,
  Effect handlers, runtime clients, retry/watch, Redis/Valkey, inspector and
  Neem integration.
- [PostgreSQL](references/postgres.md) - accepted clients, transaction scopes,
  timestamp parsers, schema version 4, Drizzle migrations and LISTEN ownership.
- [PubSub](references/pubsub.md) - typed channels, delivery semantics,
  Redis/Valkey adapter ownership and the Effect service.
