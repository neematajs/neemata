---
title: Jobs
description: Background job definitions, steps, job manager, retry/backoff, progress
  checkpoints, job router, and server configuration.
---

# Jobs

Neemata's job system is built on BullMQ. Each job gets a dedicated queue and runs
in a separate worker thread pool. Jobs require a store (Redis or Valkey).

## Defining a Job

Jobs are built with a chainable API: define options, add steps, then finalize with `.return()`:

```typescript
import { n, t, JobWorkerPool } from 'nmtjs'

const processUserJob = n.job({
  name: 'processUser',
  pool: JobWorkerPool.Io,
  input: t.object({ userId: t.string() }),
  output: t.object({ success: t.boolean() }),
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
})
  .step(n.step({
    label: 'fetch-user',
    input: t.object({ userId: t.string() }),
    output: t.object({ user: t.object({ name: t.string() }) }),
    handler: async (ctx, input) => {
      const user = await fetchUser(input.userId)
      return { user }
    },
  }))
  .step(n.step({
    label: 'process',
    input: t.object({ user: t.object({ name: t.string() }) }),
    output: t.object({ success: t.boolean() }),
    handler: async (ctx, input) => {
      await doSomething(input.user)
      return { success: true }
    },
  }))
  .return()
```

### Job Options

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Unique job name (used as queue name) |
| `pool` | `JobWorkerPool` | `Io` or `Compute` — which worker pool runs this job |
| `input` | `t.*` schema | Input data schema |
| `output` | `t.*` schema | Final output schema |
| `progress` | `t.*` schema | Optional user-defined progress state schema |
| `dependencies` | `Record<string, Injectable>` | DI dependencies for job context |
| `data` | `(ctx, input, progress) => Data` | Factory for per-execution context data |
| `attempts` | `number` | Max retry attempts |
| `backoff` | `JobBackoffOptions` | Retry strategy: `{ type: 'fixed' | 'exponential', delay: number, jitter?: number }` |
| `concurrency` | `number` | Max concurrent executions (defaults to pool capacity / jobs) |
| `timeout` | `number` | Execution timeout in ms |
| `oneoff` | `boolean` | If true (default), remove job on complete/fail |

### Builder Chain

1. `n.job(options)` — create job
2. `.step(step, condition?)` — add a step (can repeat). Condition: `({context, data, input, result, progress}) => boolean`
3. `.return(handler?)` — **required** to finalize. Maps accumulated result to output. Handler optional if types already match
4. `.beforeEach(handler)` / `.afterEach(handler)` — per-step hooks (after `.return()`)
5. `.onError(handler)` — per-step error hook; return `false` to make error unrecoverable

## Defining Steps

Each step has typed input (from accumulated prior results) and typed output (merged into result for subsequent steps):

```typescript
const fetchStep = n.step({
  label: 'fetch-data',
  input: t.object({ id: t.string() }),
  output: t.object({ data: t.any() }),
  dependencies: { db: dbInjectable },
  handler: async ({ db }, input) => {
    return { data: await db.find(input.id) }
  },
})
```

### Conditional Steps

```typescript
myJob
  .step(fetchStep)
  .step(optionalStep, ({ result }) => result.needsProcessing === true)
  .return()
```

## Enqueuing Jobs from Procedures

Use the `jobManager` injectable to add jobs from RPC handlers:

```typescript
import { n, t } from 'nmtjs'

const startJobProcedure = n.procedure({
  dependencies: { jobManager: n.inject.jobManager },
  input: t.object({ userId: t.string() }),
  output: t.object({ jobId: t.string() }),
  handler: async ({ jobManager }, input) => {
    const result = await jobManager.add(processUserJob, {
      userId: input.userId,
    })
    return { jobId: result.id }
  },
})
```

### Job Manager API (`n.inject.jobManager`)

| Method | Description |
|---|---|
| `add(job, data, options?)` | Enqueue a job. Returns `QueueJobResult` with `.id` and `.waitResult()` |
| `list(job, options?)` | Paginated listing. Options: `{ page?, limit?, status?[] }` |
| `get(job, id)` | Get a single job by ID |
| `getInfo(job)` | Get job definition info (name, steps, labels) |
| `retry(job, id, options?)` | Retry a job. `{ clearState?: boolean }` — clear checkpoint or resume |
| `cancel(job, id)` | Cancel a waiting or active job |
| `remove(job, id)` | Remove a job from the queue |

### Add Options

```typescript
jobManager.add(myJob, data, {
  jobId: 'custom-id',       // custom job ID
  priority: 1,              // higher = processed first
  delay: 5000,              // delay before processing (ms)
  attempts: 5,              // override job-level attempts
  backoff: { type: 'fixed', delay: 2000 },
  oneoff: false,            // keep job after completion
  forceMissingWorkers: true, // enqueue even if no workers running
})
```

### Waiting for Result

```typescript
const queueResult = await jobManager.add(myJob, { userId: '123' })
const output = await queueResult.waitResult() // typed as job's output
```

## Job Injectables

These are available inside job step handlers and job hooks:

| Injectable | Scope | Type | Description |
|---|---|---|---|
| `n.inject.jobManager` | Global | `JobManagerInstance` | Enqueue/list/cancel jobs |
| `n.inject.jobAbortSignal` | Global | `AbortSignal` | Cancellation signal for current job |
| `n.inject.saveJobProgress` | Global | `() => Promise<void>` | Manually persist progress mid-step |
| `n.inject.currentJobInfo` | Global | `JobExecutionContext` | Current job metadata (name, id, attempts) |
| `n.inject.jobWorkerPool` | Global | `JobWorkerPool` | Current worker's pool type |

### Saving Progress Mid-Step

For long-running steps, persist progress to allow resumption on failure:

```typescript
const longStep = n.step({
  dependencies: { saveProgress: n.inject.saveJobProgress },
  input: t.object({ items: t.array(t.string()) }),
  output: t.object({ processed: t.number() }),
  handler: async ({ saveProgress }, { items }) => {
    for (const item of items) {
      await processItem(item)
      await saveProgress() // checkpoint persisted to Redis
    }
    return { processed: items.length }
  },
})
```

### Handling Cancellation

```typescript
const cancellableStep = n.step({
  dependencies: { signal: n.inject.jobAbortSignal },
  input: t.object({}),
  output: t.object({ done: t.boolean() }),
  handler: async ({ signal }, input) => {
    while (!signal.aborted) {
      await doWork()
    }
    return { done: !signal.aborted }
  },
})
```

## Job Router (Management API)

Expose job CRUD operations as RPC procedures:

```typescript
import { n } from 'nmtjs'

const jobManagementRouter = n.jobRouter({
  jobs: { processUser: processUserJob },
  guards: [adminGuard],
})

// Generates nested router:
// processUser/info, processUser/list, processUser/get,
// processUser/add, processUser/retry, processUser/cancel, processUser/remove

export const router = n.rootRouter([appRouter, jobManagementRouter])
```

### Customizing Operations

Disable or customize individual operations per job:

```typescript
const jobManagementRouter = n.jobRouter({
  jobs: { processUser: processUserJob },
  defaults: {
    remove: false,  // disable remove for all jobs
  },
  overrides: {
    processUser: {
      add: n.jobRouterOperation({
        guards: [specificGuard],
        // beforeAdd / afterAdd hooks available
      }),
      cancel: false,  // disable cancel for this job
    },
  },
})
```

## Server Configuration

Jobs require a store and pool configuration in `n.server()`:

```typescript
import { n, StoreType, JobWorkerPool } from 'nmtjs'

export default n.server({
  store: {
    type: StoreType.Redis,
    options: { host: '127.0.0.1', port: 6379 },
  },
  jobs: {
    pools: {
      [JobWorkerPool.Io]: { threads: 2, jobs: 5 },
      [JobWorkerPool.Compute]: { threads: 1, jobs: 2 },
    },
    jobs: [processUserJob],
    ui: { port: 3001 },  // optional BullBoard UI (read-only)
  },
  // ...
})
```

### Pool Types

| Pool | Use for |
|---|---|
| `JobWorkerPool.Io` | I/O-bound jobs (API calls, database queries, file processing) |
| `JobWorkerPool.Compute` | CPU-bound jobs (data processing, calculations) |

Each pool gets `threads` worker threads. `jobs` is the number of concurrent jobs per thread.

### Progress & Checkpoints

Jobs automatically checkpoint after each step. On failure and retry:
- If `clearState: true` — reruns from the beginning
- If `clearState: false` (default for failed jobs) — resumes from the last completed step
