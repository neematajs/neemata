---
name: use-neemata
description: 'Use when answering questions or writing code for Neemata durable workflows and pubsub: task and workflow contracts, implementations, execution pools, the PostgreSQL runtime, the runtime client, Neem workflow workers, and typed publish/subscribe channels, with or without Effect.'
---

# Use Neemata

Neemata is Neem hosting, durable workflows and typed pubsub. It has no RPC
framework, transports, client, or dependency container: applications own those (Effect applications
use Effect's `HttpApi` and `Rpc` with their derived clients).

- Workflows without Effect import from `@nmtjs/workflows`; Effect applications
  import the same functions from `@nmtjs/workflows/effect`.
- Pubsub imports from `@nmtjs/pubsub`, `@nmtjs/pubsub/redis` and
  `@nmtjs/pubsub/effect`.
- Neem workers import from `@nmtjs/workflows/neem` or
  `@nmtjs/workflows/effect/neem`.
- Hosting an Effect application in Neem uses `@nmtjs/effect`; configuring and
  running Neem itself is covered by the `use-neem` skill.

## References

- [Workflows](references/workflows.md) - durable orchestration: task/workflow
  contracts, implementations, pools, postgres runtime, client (read models, watch,
  retry/delete), inspector serialization, Neem integration.
- [PubSub](references/pubsub.md) - typed channels, publish/subscribe, Redis and
  Valkey adapter, Effect service.
