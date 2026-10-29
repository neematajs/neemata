# Package Integration

Register runtime declaration files in `NeemConfig.runtimes`. Package helpers
supply their own defaults; the app owns its entry modules and resources.
Neem owns discovery, artifacts, lifecycle, env, proxying, health, and selection.

- `createWorkflowsRuntime({ ... })` from `@nmtjs/workflows/neem` directly
  creates a workflows declaration; the app supplies its planner and worker.
- `createEffectRuntime({ ... })` directly creates a declaration with the
  single-worker Effect planner. See [Effect applications](effect.md).
- For an entirely app-owned runtime, use `defineRuntime` from `@nmtjs/neem`;
  see [declaration rules](runtimes.md#discovery-and-declarations). Detailed
  worker/host authoring belongs in `build-neem-runtime`.
- Metrics supplies a controller plugin, not a runtime. Put
  `metrics(...)` from `@nmtjs/metrics/neem` in `plugins`; see [metrics](metrics.md).

## Workflows Runtime

```ts
// workflows.runtime.ts
import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

export default createWorkflowsRuntime({
  name: 'workflows',
  planner: './workflows.planner.ts',
  worker: { entry: './workflows.worker.ts' },
})
```

The planner describes deployment, not application declarations or clients.
It executes in Neem's host-runner thread; keep app imports in the worker.

```ts
// workflows.planner.ts
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1, concurrency: 4 },
  pools: { jobs: { threads: 2, concurrency: 1, cleanupTimeoutMs: 1_000 } },
}))
```

`defineWorkflowsPlanner` takes a zero-argument sync/async factory returning
`{ coordinator?, pools }`. At least one named execution pool is required, and
every pool a declaration names must be planned. The coordinator and each pool
take `threads` (default 1, a positive integer) plus the options of the worker
they run, passed through unchanged: `concurrency` (1), `leaseMs` (30,000) and
`pollMs` (250) for both, `cleanupTimeoutMs` (5,000) for pools, and the
maintenance options (`reaping`, `runTimeouts`, `scheduling`, `retention`) for
the coordinator. Concurrency is per thread, not cluster-wide. The plan is
copied to threads as data, so schedules belong to the worker. Neem names the
threads `<runtime>:coordinator:<n>` and `<runtime>:execution:<n>`.

### Worker

`defineWorkflowsWorker` from `@nmtjs/workflows/neem/worker` (requires the
`@nmtjs/effect` and `effect@^4.1.0` peers) takes
`{ workflows?, tasks?, schedules?, store, layer? }`:

- `workflows` / `tasks` are declaration arrays, typically
  `Root.workflows` / `Root.tasks`. Repeated declarations count once.
- `schedules` is the deployment's complete list. Coordinators reconcile the
  stored schedules to it, removing any other; omitted, they are left alone.
- `store(ctx)` returns a `Layer` providing `Store`. Every thread builds its
  own, so threads share runs only through a durable store (PostgreSQL or
  Redis); `InMemory.layer()` is per thread.
- `layer(ctx)` returns a `Layer` of the handlers' services; it may require
  `Store`. Its type must cover every task and activity handler of the
  definition; it is optional only when they need none. It is built only in
  execution threads.
- Both are called each time a thread starts, including dev reloads in the
  same thread. `ctx.data` names the `role` (`'coordinator' | 'execution'`),
  the `pool` and the planned `pools`; `ctx.logger` receives `Effect.log*`.

```ts
// workflows.worker.ts
import { NodeRedis } from '@effect/platform-node'
import { task } from '@nmtjs/workflows'
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem/worker'
import * as Redis from '@nmtjs/workflows/redis'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

const Normalize = task({
  name: 'normalize',
  pool: 'jobs',
  input: Schema.String,
  output: Schema.String,
  handler: (input) => Effect.succeed(input.trim()),
})

export default defineWorkflowsWorker({
  tasks: [Normalize],
  store: () =>
    Redis.layer({ prefix: 'jobs:' }).pipe(
      Layer.provide(NodeRedis.layer({ url: process.env.REDIS_URL! })),
    ),
})
```

A thread starts only if `Worker.verify` accepts the definition with the
planned pools and schedules: missing child workflows, tasks or schedule
targets, two declarations of one name and revision, and undeclared pools fail
startup before anything is acquired.

On stop, Neem interrupts the thread: handlers are interrupted and their
commands given back for redelivery, coordinator passes under way finish, then
the handler services and the store are released. A handler that outlives its
pool's `cleanupTimeoutMs` fails the thread with `CleanupTimeout` so Neem
replaces it; services are not released under a running handler. A requested
stop has Neem's separate hard
[5,000 ms thread deadline](cli.md#start-failure-and-shutdown).

This helper owns the coordinator/execution workers and readiness; it is built
on `defineEffectWorker` from `@nmtjs/effect`, whose application-owned
`main(ready)` API is for other Effect services.

## Store Ownership

Acquire store clients inside the worker's `store` layer, never in
`neem.config.ts` or at module level: the layer is released with the thread.

- Redis/Valkey: `@nmtjs/workflows/redis` runs on Effect's `Redis` service,
  e.g. `NodeRedis.layer` from `@effect/platform-node`. Threads of one
  workflows runtime share a `prefix`; isolate independent runtimes with
  distinct prefixes. Use `maxmemory-policy noeviction`. A failure while a
  script is in flight leaves its outcome unknown; retry the high-level
  operation with the same idempotency identity.
- PostgreSQL: `Postgres.layer()` over an Effect `SqlClient` (`@effect/sql-pg`),
  optionally with `PostgresPg.notifications` for hints. The app owns
  migrations; run `Postgres.verify` at startup. See the workflows package
  README for the transaction and schema contracts.
