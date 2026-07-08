---
name: use-neemata
description: 'Use when answering questions or writing code for Neemata RPC applications: contracts, procedures, routers, applications, DI, metadata, guards, middleware, filters, clients, workflows, pubsub, metrics, streaming, blobs, and Neemata runtime integration.'
---

# Use Neemata

End-user Neemata application code should prefer `nmtjs` umbrella imports for
application, contract, type, DI, pubsub, and metrics APIs when
the needed symbol is exported there.

Exceptions:

- Client code imports from `@nmtjs/client`, client transports, and formats.
- Server transports import from `@nmtjs/http-transport`, `@nmtjs/ws-transport`,
  and their `/node`, `/bun`, `/deno` subpaths.
- Neem runtime helpers import from package `/neem` subpaths.
- Adapters import from package adapter subpaths such as `@nmtjs/pubsub/redis`.

## References

- [API Reference](references/api-reference.md) - umbrella exports and import rules.
- [Application Setup](references/server-setup.md) - app, host, transports,
  Neemata runtime files.
- [Contracts](references/contracts.md) - RPC, event, subscription, and blob
  public API shapes.
- [RPC](references/rpc.md) - procedures, routers, execution pipeline,
  streaming, blobs, metadata, filters.
- [Implementations](references/implementations.md) - contract-backed handlers,
  routers, and `implementRouter(...)`.
- [Injectables](references/injectables.md) - values, lazy tokens, factories,
  scopes, built-ins.
- [Subscriptions](references/subscriptions.md) - typed event/channel contracts.
- [PubSub](references/pubsub.md) - ephemeral fanout, publish/subscribe.
- [Workflows](references/workflows.md) - durable orchestration: task/workflow
  contracts, implementations, postgres runtime, client (read models, watch,
  retry/delete), inspector serialization, Neem integration.
- [Type System](references/type-system.md) - `t.*` schemas and encode/decode.
- [Client Usage](references/client-usage.md) - typed clients, transports,
  streams, blobs, cancellation.
