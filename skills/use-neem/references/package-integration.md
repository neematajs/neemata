# Package Integration

Register runtime declaration files in `NeemConfig.runtimes`. Package helpers
supply their own defaults; the app owns its entry modules and resources.
Neem owns discovery, artifacts, lifecycle, env, proxying, health, and selection.

- `createWorkflowsRuntime()` returns a declaration helper with the workflows
  host entry. The app supplies its planner and worker.
- `createEffectRuntime({ ... })` directly creates a declaration with the
  single-worker Effect planner. See [Effect applications](effect.md).
- For an entirely app-owned runtime, use `defineRuntime` from `@nmtjs/neem`;
  see [declaration rules](runtimes.md#discovery-and-declarations). Detailed
  worker/host authoring belongs in `build-neem-runtime`.
- Metrics supplies a controller plugin, not a runtime. Put
  `metrics(...)` from `@nmtjs/metrics/neem` in `plugins`; see [metrics](metrics.md).

## Workflows Runtime

```ts
// neem.runtime.ts
import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

const defineRuntime = createWorkflowsRuntime()

export default defineRuntime({
  name: 'workflows',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

The planner describes deployment, not application implementations or clients.
It executes in Neem's host-runner thread; keep app imports in the worker.

```ts
// neem.planner.ts
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1, concurrency: 4 },
  pools: { jobs: { threads: 2, concurrency: 1, cleanupTimeoutMs: 1_000 } },
}))
```

`defineWorkflowsPlanner` takes a zero-argument sync/async factory returning
`{ coordinator?, pools }`. At least one named execution pool is required.
Coordinator and each pool accept `threads`, `concurrency`, `leaseMs`,
`pollIntervalMs`, and `cleanupTimeoutMs`. Defaults are respectively 1, 1,
30,000, 250, and 5,000; times are milliseconds. Thread counts must be positive
integers. Concurrency is per thread, not cluster-wide. Coordinators advance
runs, reconcile schedules, and maintain state; execution pools run handlers.

### Promise Worker

`defineWorkflowsWorker` takes `{ workflows, tasks?, schedules?, setup }`.
Registry fields are sync/async factories returning arrays of implementations
(or schedule definitions). `setup(ctx)` runs once per thread and returns
`{ runtime, env?, dispose? }`:

- `runtime` is a `WorkflowRuntimeAdapter` shared by that thread's loops.
- `env` is the application value passed to Promise handlers and workflow
  `finish`; it must satisfy every registered implementation's env requirements.
  It is optional only when no implementation requires it. It is unrelated to
  `NeemConfig.env`/`process.env`.
- `dispose()` releases caller-owned resources after adapter disposal. It may
  be sync or async. Clean up acquisitions yourself if `setup` throws before
  returning resources.
- `ctx` includes `logger`, `mode`, `name`, and `data`; `data` carries `role`
  (`'coordinator' | 'execution'`), optional `pool`, `settings`, and declared
  `pools`. Every thread builds its own clients; all participating threads must
  point to the same durable backend/namespace. An in-memory adapter does not
  share state across Neem threads.

This minimal task-only worker uses the `jobs` pool from the planner above:

```ts
// neem.worker.ts
import { defineTask, implementTask } from '@nmtjs/workflows'
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem'
import { createRedisWorkflowRuntime } from '@nmtjs/workflows/redis'
import { Redis } from 'ioredis'
import * as z from 'zod'

const normalize = defineTask({
  name: 'normalize',
  input: z.string(),
  output: z.string(),
})
const implementation = implementTask(normalize, {
  pool: 'jobs',
  handler: (input) => input.trim(),
})

export default defineWorkflowsWorker({
  workflows: () => [],
  tasks: () => [implementation],
  setup() {
    const redis = new Redis({
      maxRetriesPerRequest: 1,
      commandTimeout: 2_000,
    })
    const runtime = createRedisWorkflowRuntime({
      client: redis,
      keyPrefix: 'jobs:',
    })

    return {
      runtime,
      async dispose() {
        // The adapter closes its subscriber; this thread owns the command client.
        try {
          await redis.quit()
        } finally {
          redis.disconnect()
        }
      },
    }
  },
})
```

Startup rejects undeclared implementation pools, missing child/task/schedule
implementations, duplicate implementations of one name, and references using
a different definition object with the same name. Repeating the same
implementation object is deduplicated. Share definition modules between
references and implementations. Schedules require an adapter with a scheduler;
Redis does not provide one.

On stop the worker stops claims, aborts attempts, joins engine loops, drains
handlers, disposes the adapter, then calls resource `dispose` (even if adapter
disposal throws). Stop during setup waits for setup and disposes returned
resources. Cleanup overruns fail `finished` for Neem supervision; resources
are not released while handlers still use them. A requested stop has Neem's
separate hard [5,000 ms thread deadline](cli.md#start-failure-and-shutdown).

### Effect Workflows Worker

Use `defineWorkflowsWorker` from `@nmtjs/workflows/effect/neem`, with the same
runtime declaration helper and planner from `@nmtjs/workflows/neem`.
Effect task/workflow implementations come from `@nmtjs/workflows/effect`.
Install the exact optional peer `effect@4.0.0-rc.116` when using this API.

This worker takes `{ workflows, tasks?, schedules?, runtime, layer? }`, not
Promise `setup`/`env`/`dispose`:

- `runtime` is an Effect yielding a `WorkflowRuntimeAdapter`; it may require
  services and `Scope.Scope`. It is an Effect value, not a Context service tag
  or already-open adapter. Acquire external clients in its scope or Layer.
- `layer` must supply all services required by handlers, workflow finish, and
  the runtime Effect, excluding the provided scope; it must have no remaining
  inputs. It is required when services are needed, otherwise optional.
- The worker supplies a shared Effect handler runtime per thread. Services
  replace the Promise API's explicit handler env value.
- Worker/handler cleanup precedes adapter disposal, then scoped resources and
  Layer finalization. The helper calls `runtime.dispose()` itself; finalizers
  you register close the command clients/pools the adapter does not own.
- `cleanupTimeoutMs` bounds handler and worker cleanup while supervised. An
  overrun fails `finished` so Neem can recycle the thread, including its healthy
  sibling attempts. On requested stop it cannot extend Neem's host deadline.

This workflows helper owns coordinator/execution loops and readiness; it is
separate from the application-owned `main(ready)` API in `@nmtjs/effect`.

## Redis / Valkey Ownership

`createRedisWorkflowRuntime` accepts the driver-neutral `WorkflowRedisClient`
surface implemented by `ioredis` and `iovalkey`: command methods, event handling,
and connection/duplication methods. It is not a `node-redis` client adapter.
Create one command client per owning thread in Promise `setup`, or acquire it
in the Effect worker's runtime scope/Layer, never in `neem.config.ts`.

- Keep both `maxRetriesPerRequest` and `commandTimeout` finite; the example's
  `1` and `2_000` are starting values, not enforced runtime defaults. Never use
  `maxRetriesPerRequest: null`: an operation could stay queued indefinitely
  across reconnects. Reconnection for future commands can remain enabled.
- `runtime.dispose()` closes only the duplicated Pub/Sub client (falling back
  to disconnect if quit fails). The caller must close the command client after
  adapter disposal via resource `dispose` or an Effect finalizer.
- Use standalone or Sentinel-managed Redis/Valkey, not Redis Cluster. Keep
  the namespace shared for threads of one workflows runtime and isolate
  independent runtimes with distinct `keyPrefix` values.
- A timeout may follow a committed operation. Retry the high-level workflow
  operation with the same idempotency identity, not arbitrary raw commands.

For PostgreSQL, the app likewise owns its command client/pool and migrations;
close the pool after adapter disposal. The adapter disposes supplied wake events;
the PostgreSQL wake-events helper closes its listener, not the app's pool.
Follow the workflows README for connection/parser contracts.
