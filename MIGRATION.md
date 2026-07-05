# Migrating from 0.16.x to 0.17.0-beta.1

0.17 splits the old all-in-one `nmtjs` framework into focused packages. The
application-authoring API (routers, procedures, contracts, injectables) is
nearly unchanged — what changed is everything around it: how servers are
orchestrated, how background work runs, and where features live.

## TL;DR

| Area                 | 0.16                                | 0.17.0-beta.1                          |
| -------------------- | ----------------------------------- | -------------------------------------- |
| Umbrella package     | `nmtjs` (framework + runtime + CLI) | `nmtjs` (re-exports only)              |
| Server orchestration | `n.server()` + `neemata` CLI        | `@nmtjs/neem` runtimes + `neem` CLI    |
| Background work      | jobs (BullMQ + Redis)               | `@nmtjs/workflows` (durable, Postgres) |
| Pub/sub              | built into the runtime              | `@nmtjs/pubsub` plugin + adapter       |
| Metrics              | built into server config            | `@nmtjs/metrics` neem plugin           |
| Eventing             | —                                   | parked, not in the beta                |

Install the beta with the `beta` dist-tag: `pnpm add nmtjs@beta` (and
`@nmtjs/neem@beta`, `@nmtjs/workflows@beta`, … as needed).

Requirements: Node.js 24, and PostgreSQL if you use workflows
(`createInMemoryWorkflowRuntime()` covers tests).

## 1. Imports: the `n` namespace is gone

`nmtjs` no longer has a default export or the `n` namespace — everything is a
named export. The builder names are otherwise the same.

```ts
// 0.16
import { n } from 'nmtjs'
const users = n.router({ ... })
const getUser = n.procedure({ ... })

// 0.17
import { router, procedure } from 'nmtjs'
const users = router({ ... })
const getUser = procedure({ ... })
```

Mechanical rename for: `app`, `host`, `procedure`, `contractProcedure`,
`router`, `rootRouter`, `contractRouter`, `guard`, `middleware`, `filter`,
`hook`, `meta`, `plugin`, `transport`, `value`, `lazy`, `factory`, `inject`,
`metrics`, `logging`, `c`, `t`, and the error/enums re-exports.

New in the umbrella: `implementRouter`, `handler`, `optional`,
`pubsubPlugin`, `PubSubInjectables`, `blobType`, and the workflows surface
(`workflow`, `task`, `schedule`, `implementWorkflow`, `implementTask`,
`WorkflowAttemptTimeoutError`).

Removed from the umbrella: `n.server`, `n.config`, `n.job`, `n.step`,
`n.jobRouter`, `n.jobRouterOperation`, `StoreType`, `WorkerType`, and the
`nmtjs/cli`, `nmtjs/config`, `nmtjs/runtime`, `nmtjs/runtime/types` subpaths.

## 2. Server orchestration: `n.server()` → Neem runtimes

The `neemata` bin and `n.server()` are gone. `@nmtjs/neem` is the new host: it
builds and supervises _runtimes_ (worker-thread pools behind a proxy), each
declared by a `neem.runtime.ts` file. Your `app()`/`host()` code stays as it
was — it just gets wired through a runtime instead of `n.server()`.

**0.16:**

```ts
// neemata.config.ts
import { defineConfig } from 'nmtjs/config'
export default defineConfig({
  applications: {
    main: { specifier: './src/applications/main/index.ts', type: 'neemata' },
  },
  serverPath: './src/index.ts',
})

// src/index.ts
export default n.server({
  applications: { main: { threads: [{ http: { listen: { port: 3002 } } }] } },
  proxy: { port: 4000, applications: { main: { routing: { default: true } } } },
})
```

**0.17:**

```ts
// src/runtimes/api/api.ts — unchanged application code
import { app, host } from 'nmtjs'
import { HttpTransport } from '@nmtjs/http-transport/node'
import { api } from './router.ts'
export const application = app({ router: api })
export default host(application, { transports: { http: HttpTransport } })

// src/runtimes/api/neem.runtime.ts
import { createNeemataRuntime } from '@nmtjs/application/neem/runtime'
export default createNeemataRuntime()({
  name: 'api',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})

// src/runtimes/api/neem.planner.ts — instance counts and listen ports live here
import { defineNeemataPlanner } from '@nmtjs/application/neem/planner'
export default defineNeemataPlanner(() => ({
  instances: 2,
  transports: { http: { listen: { hostname: '127.0.0.1', port: 0 } } },
}))

// src/runtimes/api/neem.worker.ts
import { defineNeemataWorker } from '@nmtjs/application/neem/worker'
import applicationHost from './api.ts'
export default defineNeemataWorker(applicationHost)

// neem.config.ts — replaces neemata.config.ts
import { defineConfig } from '@nmtjs/neem'
export default defineConfig({
  proxy: {
    hostname: '127.0.0.1',
    port: 3000,
    runtimes: { api: { routing: { default: true } } },
  },
  runtimes: ['./src/runtimes/**/neem.runtime.ts'],
})
```

### CLI

| 0.16              | 0.17                                   |
| ----------------- | -------------------------------------- |
| `neemata dev`     | `neem dev [runtime,…]`                 |
| `neemata build`   | `neem build [runtime,…]`               |
| `neemata preview` | `neem start [runtime,…] --outDir dist` |
| `neemata prepare` | folded into `neem build`               |

`neem build` emits `dist/neem.manifest.json` plus per-runtime start
artifacts; `neem start` runs the built manifest in production.

## 3. Jobs → Workflows

The BullMQ/Redis jobs engine (`n.job`, `n.step`, `n.jobRouter`,
`inject.jobManager`, worker pools, `StoreType.Redis`) is removed. There is no
compatibility shim: `@nmtjs/workflows` is a successor with a different, more
durable model — Postgres-backed workflow DAGs with tasks, activities,
branches, parallel and map fan-outs, retries, idempotency, cancellation via
`AbortSignal`, and cron scheduling.

```ts
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'
// (also re-exported from nmtjs as task / workflow / schedule / implementTask / implementWorkflow)

const embedTask = defineTask({
  name: 'content.embed',
  input,
  output,
  retry: { attempts: 3, backoff: 'exponential' },
  timeout: '30s',
})

const publishWorkflow = defineWorkflow({
  name: 'content.publish',
  input,
  output,
})
  .activity('render', { input, output })
  .task('embedding', embedTask)
  .build()

const embedImpl = implementTask(embedTask, {
  idempotency: (_, input) => ['content.embed', input.entityId],
  async handler(ctx, input, lifecycle) {
    /* lifecycle.signal aborts in-flight work */
  },
})

const publishImpl = implementWorkflow(publishWorkflow, {})
  .render(async (_, input) => ({ html: await render(input.draftId) }))
  .embedding(embedTask, {
    input: (_, { render }, input) => ({ text: render.html }),
  })
  .finish((_, { embedding }, input) => ({ url: embedding.url }))
```

Starting and managing runs:

```ts
import { Pool } from 'pg'
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'

const connection = createPostgresWorkflowConnection(
  new Pool({ connectionString }),
)
await verifyPostgresWorkflowSchema(connection)
const runtime = createPostgresWorkflowRuntime({ connection })
const client = createWorkflowRuntimeClient({
  ...runtime,
  workflows: [publishImpl],
  tasks: [embedImpl],
})

const run = await client.start(
  publishWorkflow,
  { draftId: 'd1' },
  { idempotencyKey: ['content.publish', 'd1'] },
)
await client.get(run.id)
await client.cancel(run.id)
await client.list({ tags: ['content'] })
```

Cron scheduling replaces ad-hoc job repetition via `defineSchedule`
(`schedule` in the umbrella). Neem wiring lives in `@nmtjs/workflows/neem`
(`defineWorkflows`, `createWorkflowsRuntime`, planner/worker helpers) with
dedicated `coordinator`/`activity`/`task` worker pools.

## 4. Pub/sub: server store → `@nmtjs/pubsub` plugin

Pub/sub is no longer wired through `n.server({ store: ... })`. It is an
application plugin with an explicit adapter.

```ts
// 0.16: n.server({ store: { type: StoreType.Redis, options } })
//       inject.publish / inject.subscribe / inject.subscriptionAdapter

// 0.17
import { app, pubsubPlugin, inject } from 'nmtjs'
import { createRedisAdapter } from '@nmtjs/pubsub/redis'

const application = app({
  router,
  plugins: [pubsubPlugin({ adapter: createRedisAdapter(redisClient) })],
})
```

Signature changes:

- `publish(event, params, payload)` — returns `Promise<boolean>`
- `subscribe(subscription, params, events?, signal?)` — returns an async
  iterable stream
- injectable rename: `inject.subscriptionAdapter` → `inject.pubsubAdapter`

Subscription/event contracts (`c.subscription`, `c.event`) are conceptually
unchanged.

## 5. Metrics

`metrics.counter/gauge/histogram/summary` still come from the umbrella (now
backed by `@nmtjs/metrics`). The `/metrics` endpoint moved from server config
to a Neem plugin:

```ts
// neem.config.ts
import metrics from '@nmtjs/metrics/neem'
import { defineConfig } from '@nmtjs/neem'
export default defineConfig({
  plugins: [
    metrics({
      server: { host: '127.0.0.1', port: 9187, path: '/metrics' },
      defaultMetrics: true,
    }),
  ],
  runtimes: ['./src/runtimes/**/neem.runtime.ts'],
})
```

## 6. Removed with no replacement in the beta

- The entire jobs engine and its injectables (`jobManager`,
  `jobAbortSignal`, `saveJobProgress`, `currentJobInfo`, `jobWorkerPool`) —
  migrate to workflows.
- The jobs management API (`n.jobRouter`, `n.jobRouterOperation`).
- `n.server` / `defineServer`, `StoreType`, `WorkerType`, `n.config`.
- The `neemata` bin and `nmtjs/cli`, `nmtjs/config`, `nmtjs/runtime`,
  `nmtjs/runtime/types` subpaths.
- Eventing — parked for a future release; not part of the beta.

## Suggested migration order

1. Upgrade imports: drop the `n` namespace, switch to named exports.
2. Move orchestration: delete `n.server()` + `neemata.config.ts`, add
   `neem.config.ts` and one runtime directory per deployable unit, switch
   scripts to the `neem` CLI.
3. Re-wire pub/sub through `pubsubPlugin` + an adapter; rename the adapter
   injectable.
4. Port background jobs to workflows (this is a redesign, not a rename —
   plan it per job): stand up the Postgres schema, translate each job's
   steps into workflow nodes, replace `jobManager.add` call sites with a
   workflow runtime client.
5. Move the metrics endpoint into the neem metrics plugin.
