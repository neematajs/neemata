# Jobs

Use jobs for durable background work. A job is a typed unit of queued work with
input, output, optional progress, step pipeline, lifecycle hooks, and queue
operations. Jobs are not RPC procedures; expose queue operations through RPC
only when the product API needs enqueue/status/retry/cancel/remove access.

End-user application code should prefer `nmtjs` exports: `job`, `step`,
`jobRouter`, `jobOperation`, `jobsPlugin`, and `inject`.

## Job Definition

```ts
import { job, t } from 'nmtjs'

export const echoJob = job({
  name: 'echo',
  pool: 'default',
  input: t.object({ message: t.string() }),
  output: t.object({ ok: t.boolean(), message: t.string() }),
}).return(({ input }) => ({ ok: true, message: input.message }))
```

Rules:

- `name` identifies the job and its queue.
- `pool` selects the Neem jobs worker pool.
- `input`, `output`, and optional `progress` are Neemata type schemas.
- Queue options include `concurrency`, `timeout`, `attempts`, `backoff`, and
  `oneoff`.
- `data` may build per-run ephemeral state from job dependencies, decoded input,
  and restored progress.
- Every runnable job must end with `.return(...)`. If accumulated step output
  already satisfies `output`, `.return()` may omit a handler.

## Per-Run Data

Use job `data` for derived state shared by all steps and hooks in one execution.
It is recomputed on retry/restart; persist resumable state in `progress`.

```ts
import { job, step, t } from 'nmtjs'
import { tenantApi } from './injectables.ts'

type SyncData = {
  tenant: { id: string }
  startCursor?: string
}

const syncPage = step({
  dependencies: { api: tenantApi },
  input: t.object({ tenantId: t.string() }),
  output: t.object({ synced: t.number(), cursor: t.string().optional() }),
  async handler({ api }, _input, data: SyncData) {
    const page = await api.listUsers({
      tenantId: data.tenant.id,
      cursor: data.startCursor,
    })
    return { synced: page.items.length, cursor: page.nextCursor }
  },
})

export const syncUsersJob = job({
  name: 'sync-users',
  pool: 'io',
  dependencies: { api: tenantApi },
  input: t.object({ tenantId: t.string() }),
  output: t.object({ synced: t.number() }),
  progress: t.object({ cursor: t.string().optional() }),
  async data({ api }, input, progress): Promise<SyncData> {
    return {
      tenant: await api.getTenant(input.tenantId),
      startCursor: progress.cursor,
    }
  },
})
  .step(syncPage)
  .return(({ result }) => ({ synced: result.synced }))
```

`data` is passed as the third argument to step handlers and as `params.data` to
conditions, hooks, and `.return(...)`.

## Steps

```ts
import { job, step, t } from 'nmtjs'

const loadImage = step({
  label: 'load image',
  input: t.object({ imageId: t.string() }),
  output: t.object({ path: t.string() }),
  handler: async (_ctx, input) => ({ path: `/tmp/${input.imageId}` }),
})

export const resizeImageJob = job({
  name: 'resize-image',
  pool: 'media',
  input: t.object({ imageId: t.string() }),
  output: t.object({ path: t.string(), width: t.number() }),
})
  .step(loadImage)
  .return(({ result }) => ({ path: result.path, width: 640 }))
```

Step rules:

- A step receives dependency context, current accumulated input/result, and job
  data.
- Each step output is merged into accumulated job result.
- A later step input must be satisfied by accumulated result.
- `.step(step, condition?)` makes that step conditional; conditional output is
  typed as partial.
- `.steps(stepA, stepB, ...)` adds a parallel group; all steps must be valid for
  the same accumulated input/data.
- Parallel siblings observe the same input/result snapshot. Their outputs are
  merged after the whole group succeeds; overlapping output keys fail the group.

## Runtime Context

Jobs can request runtime-provided injectables:

```ts
import { inject, job, step, t } from 'nmtjs'

type ProgressData = { progress: { done?: number } }

const report = step({
  dependencies: {
    save: inject.saveJobProgress,
    signal: inject.jobAbortSignal,
  },
  input: t.object({ total: t.number() }),
  output: t.object({ done: t.number() }),
  async handler({ save, signal }, input, data: ProgressData) {
    signal.throwIfAborted()
    data.progress.done = input.total
    await save()
    return { done: input.total }
  },
})

export const progressJob = job({
  name: 'progress',
  pool: 'default',
  input: t.object({ total: t.number() }),
  output: t.object({ done: t.number() }),
  progress: t.object({ done: t.number().optional() }),
  data: (_ctx, _input, progress): ProgressData => ({ progress }),
})
  .step(report)
  .return()
```

Available job injectables:

- `inject.jobManager` - public queue manager for enqueue/status/retry/cancel.
- `inject.jobWorkerPool` - current worker pool name inside job workers.
- `inject.jobAbortSignal` - abort signal for current running job.
- `inject.saveJobProgress` - persist current progress checkpoint.
- `inject.currentJobInfo` - current job execution metadata.

## Progress And Retry

Jobs checkpoint after every completed step. A checkpoint contains next step
index, step results, accumulated result, and user progress. `saveJobProgress`
persists the current checkpoint from inside a long-running step.

Retry behavior:

- `retry(job, id, { clearState: false })` resumes from the stored checkpoint.
- `retry(job, id, { clearState: true })` clears progress and reruns from step
  zero.
- Failed jobs default to resume; completed jobs default to rerun.
- `onError(...)` may return `false` to mark the failure unrecoverable.

## Hooks

Job builder hooks run inside the job worker:

```ts
import { inject, job, t } from 'nmtjs'

export const auditedJob = job({
  name: 'audited',
  pool: 'default',
  input: t.object({ message: t.string() }),
  output: t.object({ ok: t.boolean() }),
  dependencies: { logger: inject.logger },
})
  .return(() => ({ ok: true }))
  .beforeEach(({ context, step }) => {
    context.logger.info({ step: step.label }, 'job step starting')
  })
  .afterEach(({ context, result }) => {
    context.logger.info({ result }, 'job step completed')
  })
  .onError(({ context, error }) => {
    context.logger.error({ err: error }, 'job step failed')
  })
```

Use `dependencies` on the job or step when hooks need services. Request
`inject.logger` explicitly; logger is not magic context.

Runtime lifecycle hooks live in jobs runtime config:

```ts
export const jobsConfig = defineJobs({
  client: createJobsClient,
  pools: { default: { threads: 2, jobs: 4 } },
  jobs: () => [echoJob],
  hooks: () => ({
    added: (event) => audit(event),
    updated: (event) => audit(event),
    removed: (event) => audit(event),
  }),
})
```

## Enqueue From RPC

```ts
import { inject, procedure, t } from 'nmtjs'

export const enqueueEcho = procedure({
  dependencies: { jobs: inject.jobManager },
  input: t.object({ message: t.string() }),
  output: t.object({ id: t.string(), result: echoJob.output }),
  async handler({ jobs }, input) {
    const queued = await jobs.add(echoJob, input, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 1000 },
    })

    return { id: queued.id, result: await queued.waitResult() }
  },
})
```

`jobs.add(job, data, options)` returns `{ id, name, waitResult() }` typed to the
job output. Manager methods also include `list`, `get`, `getInfo`, `retry`,
`cancel`, and `remove`.

Add options:

- `jobId`, `priority`, and `delay` control queue identity and scheduling.
- `attempts`, `backoff`, and `oneoff` override job-level retry/retention.
- `forceMissingWorkers` allows enqueue before any worker is attached.

## Job Router

Use `jobRouter(...)` when the API should expose standard operations for jobs:

```ts
import { jobOperation, jobRouter, rootRouter, router } from 'nmtjs'

const jobs = jobRouter({
  jobs: { echo: echoJob },
  defaults: { remove: false },
  overrides: {
    echo: {
      add: jobOperation({
        beforeAdd: async (_ctx, input) => input,
        afterAdd: async (_ctx, result) => {
          await audit({ queued: result.id })
        },
      }),
      cancel: false,
    },
  },
})

export const api = rootRouter([
  router({
    routes: { jobs },
  }),
] as const)
```

Operations per job: `info`, `list`, `get`, `add`, `retry`, `cancel`, `remove`.
Each operation can have guards, middlewares, meta, timeout, and operation hooks.
Set an operation to `false` to disable it.

## App Plugin

Use `jobsPlugin(...)` when the Neemata app process needs a `jobManager`, for
example to enqueue jobs from RPC:

```ts
import { app, jobsPlugin } from 'nmtjs'

export default app({
  router: api,
  plugins: [
    jobsPlugin({
      client: createJobsClient,
      jobs: [echoJob, resizeImageJob],
    }),
  ],
})
```

The plugin creates queues, provides `inject.jobManager`, and closes the jobs
client during application dispose. It does not run worker pools; workers belong
to the jobs Neem runtime.

## Neem Runtime

Jobs runtime helpers are package-owned and stay on `@nmtjs/jobs/neem`:

```ts
// config.ts
import { defineJobs } from '@nmtjs/jobs/neem'

export const jobsConfig = defineJobs({
  client: createJobsClient,
  pools: {
    default: { threads: 2, jobs: 4 },
    media: { threads: 1, jobs: 1 },
  },
  jobs: () => [echoJob, resizeImageJob],
})
```

```ts
// neem.runtime.ts
import { createJobsRuntime } from '@nmtjs/jobs/neem'

const defineRuntime = createJobsRuntime()

export default defineRuntime({
  name: 'jobs',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

```ts
// neem.planner.ts
import { defineJobsPlanner } from '@nmtjs/jobs/neem'

import { jobsConfig } from './config.ts'

export default defineJobsPlanner(() => jobsConfig)
```

```ts
// neem.worker.ts
import { defineJobsWorker } from '@nmtjs/jobs/neem'

import { jobsConfig } from './config.ts'

export default defineJobsWorker(jobsConfig)
```

Runtime rules:

- `createJobsRuntime()` contributes the package-owned jobs host entry.
- App runtime declaration owns `name`, `planner`, and `worker.entry`.
- `defineJobsPlanner(...)` plans one worker group per configured pool.
- `defineJobsWorker(...)` defines worker-side job execution.
- Planner/worker entries are import specifiers and separate artifacts; do not
  import entry modules into each other.
