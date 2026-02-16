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

## How Job Execution Works

At runtime, each job execution follows this flow:

1. Decode job input and restore checkpointed state (`progress`, completed step results, next step index)
2. Resolve job-level dependencies (`dependencies` on `n.job`)
3. Build execution-scoped `data` once (if `data` callback is provided)
4. Run remaining steps in order (respecting optional step conditions)
5. Merge each step output into the accumulated result
6. Run `.return()` handler to produce the final typed output

On retry with checkpoint resume (`clearState: false`), completed steps are not re-executed.
On retry from scratch (`clearState: true`), execution restarts from step 0.

For parallel groups created with `.steps(...)`, sibling steps run together and their outputs
are merged after the whole group settles. If siblings emit overlapping output keys,
the group fails with a key-conflict error.

### Job Options

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Unique job name (used as queue name) |
| `pool` | `JobWorkerPool` | `Io` or `Compute` — which worker pool runs this job |
| `input` | `t.*` schema | Input data schema |
| `output` | `t.*` schema | Final output schema |
| `progress` | `t.*` schema | Optional user-defined progress state schema |
| `dependencies` | `Record<string, Injectable>` | DI dependencies for job context |
| `data` | `(ctx, input, progress) => Data` | Async/sync factory for ephemeral execution context shared across all steps/hooks |
| `attempts` | `number` | Max retry attempts |
| `backoff` | `JobBackoffOptions` | Retry strategy: `{ type: 'fixed' | 'exponential', delay: number, jitter?: number }` |
| `concurrency` | `number` | Max concurrent executions (defaults to pool capacity / jobs) |
| `timeout` | `number` | Execution timeout in ms |
| `oneoff` | `boolean` | If true (default), remove job on complete/fail |

### Builder Chain

1. `n.job(options)` — create job
2. `.step(step, condition?)` — add a linear step (can repeat). Condition: `({context, data, input, result, progress}) => boolean`
3. `.steps(stepA, stepB, ...rest)` — add a parallel step group (**at least 2 steps**)
4. `.return(handler?)` — **required** to finalize. Maps accumulated result to output. Handler optional if types already match
5. `.beforeEach(handler)` / `.afterEach(handler)` — per-step hooks (after `.return()`)
6. `.onError(handler)` — per-step error hook; return `false` to make error unrecoverable

## `data` Callback (Functionality & Usability)

`data` builds per-run context once, before steps execute, and that value is reused by all steps/hooks in the same run.

```typescript
data: async (ctx, input, progress) => ({ ... })
```

- Receives decoded `ctx` (job dependencies), `input`, and checkpointed `progress`
- Available in step handlers (`handler(ctx, stepInput, data)`), conditions, and job hooks/`.return()` via `params.data`
- Not checkpointed: recomputed on each retry/restart

Use `data` for runtime helpers/shared derived values. Use `progress` + `n.inject.saveJobProgress` for resumable state.

### Example: Shared Context via `data` (manual typing in step)

```typescript
type SyncUsersData = {
  tenantConfig: Awaited<ReturnType<typeof userApiInjectable.getTenantConfig>>
  startCursor?: string
}

const syncUsersJob = n.job({
  name: 'syncUsers',
  pool: JobWorkerPool.Io,
  input: t.object({ tenantId: t.string() }),
  output: t.object({ synced: t.number() }),
  progress: t.object({ cursor: t.string().optional() }),
  dependencies: { userApi: userApiInjectable },
  data: async ({ userApi }, input, progress): Promise<SyncUsersData> => {
    const tenantConfig = await userApi.getTenantConfig(input.tenantId)
    return {
      tenantConfig,
      startCursor: progress.cursor,
    }
  },
})
  .step(n.step({
    label: 'sync-page',
    input: t.object({ tenantId: t.string() }),
    output: t.object({ synced: t.number() }),
    handler: async (_ctx, stepInput, data: SyncUsersData) => {
      const result = await syncPage(stepInput.tenantId, data.tenantConfig, data.startCursor)
      return { synced: result.count }
    },
  }))
  .return()
```

`data` typing in step handlers is manual (annotate the 3rd arg). Steps remain type-safe:

- Step input must satisfy the job's accumulated result at that point (including previous steps)
- Step `data` type must match the job `data` contract
- If either is incompatible, TypeScript shows a compile-time error

## Defining Steps

Each step has typed input (from accumulated prior results) and typed output (merged into result for subsequent steps):

```typescript
const fetchStep = n.step({
  label: 'fetch-data',
  input: t.object({ id: t.string() }),
  output: t.object({ data: t.any() }),
  dependencies: { db: dbInjectable },
  handler: async ({ db }, input, data) => {
    // `data` is the value returned by job `data` callback
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

## Parallel Step Groups (`.steps`)

Use `.steps(...)` when independent steps can run in parallel against the same input snapshot.

```typescript
const job = n
  .job({
    name: 'parallel-example',
    pool: JobWorkerPool.Io,
    input: t.object({ id: t.string() }),
    output: t.object({ left: t.number(), right: t.number(), total: t.number() }),
  })
  .steps(
    n.step({
      input: t.object({ id: t.string() }),
      output: t.object({ left: t.number() }),
      handler: async () => ({ left: 1 }),
    }),
    n.step({
      input: t.object({ id: t.string() }),
      output: t.object({ right: t.number() }),
      handler: async () => ({ right: 2 }),
    }),
  )
  .step(n.step({
    input: t.object({ id: t.string(), left: t.number(), right: t.number() }),
    output: t.object({ total: t.number() }),
    handler: async (_, input) => ({ total: input.left + input.right }),
  }))
  .return()
```

Notes:
- All parallel siblings observe the same pre-group result snapshot.
- Sibling outputs are merged after the whole group settles.
- If any sibling throws, the group fails.
- If siblings produce overlapping keys, the group fails with a key-conflict error.

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
| `getInfo(job)` | Get job definition info (name, steps with labels, conditional, parallel) |
| `retry(job, id, options?)` | Retry a job. `{ clearState?: boolean }` — clear checkpoint or resume |
| `cancel(job, id)` | Cancel a waiting or active job |
| `remove(job, id)` | Remove a job from the queue |

### Retry Semantics (`retry`)

- `retry(job, id, { clearState: false })`: resumes from persisted checkpoint/progress when available.
- `retry(job, id, { clearState: true })`: clears progress and reruns from step 0.
- If `clearState` is omitted:
  - failed jobs default to resume (`false`)
  - completed jobs default to rerun (`true`)
- Missing job IDs reject.
- Retrying non-retriable states (for example active jobs) rejects.

For parallel key-conflict failures, behavior depends on `clearState`:
- `clearState: false` can complete by reusing previously persisted step outputs.
- `clearState: true` reruns conflicting siblings and fails again unless the conflict is removed.

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

For completed jobs, `retry` defaults to `clearState: true` (rerun).
