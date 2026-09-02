# Workflows

Use `@nmtjs/workflows` for durable, contract-first orchestration: multi-step
processes that must survive crashes, retry safely, fan out to child runs, and
be observable/cancellable by id. Use Postgres for durable background work,
schedules, long retention, and SQL inspection. Use Redis/Valkey as a separate
hot-path runtime when dispatch latency and queue throughput matter more than
long-term retention. Both are executed by coordinator and execution workers
with at-least-once command delivery and exactly-once state transitions.

Import rules (no `nmtjs` umbrella exports; always package subpaths):

- `@nmtjs/workflows` - contracts (`defineTask`, `defineWorkflow`) and
  implementations (`implementTask`, `implementWorkflow`), public types.
- `@nmtjs/workflows/runtime` - `createWorkflowRuntimeClient`,
  `createInMemoryWorkflowRuntime`, worker loops, store/adapter types.
- `@nmtjs/workflows/postgres` - `createPostgresWorkflowConnection`,
  `createPostgresWorkflowRuntime`, `verifyPostgresWorkflowSchema`,
  `WORKFLOW_POSTGRES_SCHEMA_VERSION`.
- `@nmtjs/workflows/postgres/drizzle` - `createSchema()` so the application
  owns the tables and migrations.
- `@nmtjs/workflows/postgres/testing` - schema bootstrap helpers for tests.
- `@nmtjs/workflows/redis` - `createRedisWorkflowRuntime` and
  `WorkflowRedisClient` for the Redis/Valkey hot-path runtime.
- `@nmtjs/workflows/inspector` - UI-facing serialization: workflow graph/
  catalog JSON, wire-safe DTOs, node unit grouping.
- `@nmtjs/workflows/neem` - Neem runtime integration (`defineWorkflows`,
  `createWorkflowsRuntime`, `defineWorkflowsPlanner`, `defineWorkflowsWorker`).

## Contracts

Tasks are standalone durable units; workflows are DAGs of named nodes built
with a fluent builder and finished with `.build()`.

```ts
import { defineTask, defineWorkflow } from '@nmtjs/workflows'
import { t } from '@nmtjs/type'

export const embedTask = defineTask({
  name: 'content.embed',
  input: t.object({ entityId: t.string(), text: t.string() }),
  output: t.object({ embeddingId: t.string() }),
  retry: { attempts: 3, backoff: 'exponential' },
  timeout: '30s',
})

export const publishWorkflow = defineWorkflow({
  name: 'content.publish',
  input: t.object({ draftId: t.string() }),
  output: t.object({ url: t.string() }),
})
  .activity('render', {
    input: t.object({ draftId: t.string() }),
    output: t.object({ html: t.string() }),
  })
  .task('embedding', embedTask)
  .build()
```

Builder nodes:

- `.activity(name, { input, output })` - inline durable step implemented in
  the same workflow implementation.
- `.task(name, taskDefinition)` - reference to a standalone task.
- `.workflow(name, workflowDefinition)` - child workflow run.
- `.branch(name, { output?, cases })` - select exactly one case at runtime;
  case helpers are `activity` / `task` / `workflow`.
- `.parallel(name, (helpers) => cases)` - run all cases concurrently; output
  is a record keyed by case name.
- `.mapTask(name, task, { item, concurrency })` and
  `.mapWorkflow(name, workflow, { item, concurrency })` - fan out over
  items. Maps and parallel nodes wait for all children, preserving successful
  work and failing only after all children settle. Maps have no `mode` option.
- Task-backed nodes accept `retry` / `timeout` overrides; child-workflow nodes
  accept a `cancellation` policy.
- Everything accepts optional `title` / `description` presentation metadata
  (workflow/task options, every node's options — `.parallel()` takes them as a
  third argument — and branch/parallel case helpers). Purely declarative: no
  effect on execution or identity; surfaced by the inspector serializers.

## Implementations

`implementTask(definition, { handler, idempotency? })`; workflow
implementations chain one method per node name and end with `.finish(...)`.
Mapper callbacks receive `(ctx, outputs, input)` where `outputs` holds prior
node results.

```ts
import { implementTask, implementWorkflow } from '@nmtjs/workflows'

export const embedTaskImpl = implementTask(embedTask, {
  idempotency: (_, input) => ['content.embed', input.entityId],
  async handler(_ctx, input, lifecycle) {
    // lifecycle?.signal aborts with a WorkflowAttemptAbortError whose
    // .type is timeout/leaseLost/cancelled/shutdown
    return { embeddingId: await embed(input.text, lifecycle?.signal) }
  },
})

export const publishWorkflowImpl = implementWorkflow(publishWorkflow, {
  tags: (_, input) => ({ draftId: input.draftId }),
  idempotency: (_, input) => ['content.publish', input.draftId],
})
  .render(async (_, input) => ({ html: await render(input.draftId) }))
  .embedding(embedTask, {
    input: (_, { render }, input) => ({
      entityId: input.draftId,
      text: render.html,
    }),
  })
  .finish((_, { embedding }, input) => ({
    url: `/published/${input.draftId}?emb=${embedding.embeddingId}`,
  }))
```

Rules:

- Handlers run at-least-once; make side effects idempotent and use the
  `idempotency` key builders to deduplicate task/child runs.
- Branch nodes take `{ select, cases }`; map nodes take
  `{ items, input, idempotency? }` with per-item mappers
  `(ctx, outputs, item, input)`.
- The optional third handler argument is `AttemptLifecycle`
  (`{ signal: AbortSignal }`); cancellation is cooperative - handlers that
  ignore the signal simply run to completion. Two-argument handlers remain
  valid. `signal.reason` is a `WorkflowAttemptAbortError` (exported from the
  root) with `.type`, so libraries given the signal reject with a real Error.
- Timed-out attempts record status `timedOut` and follow the retry policy;
  `WorkflowAttemptTimeoutError` is exported from the root.

## Runtime and client

```ts
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'
import { Pool } from 'pg'

const connection = createPostgresWorkflowConnection(
  new Pool({ connectionString: databaseUrl }),
)
await verifyPostgresWorkflowSchema(connection) // fail fast on schema drift
const runtime = createPostgresWorkflowRuntime({ connection })

// Execution-side client: implementations registered for the workers.
const client = createWorkflowRuntimeClient({
  ...runtime,
  workflows: [publishWorkflowImpl],
  tasks: [embedTaskImpl],
})

// Enqueue/query-side client: registry-free — implementations are never
// needed to start runs (start resolves schemas/tags/idempotency/unique from
// the definition argument), so callers that only enqueue don't import the
// implementation graph and can't form import cycles with it. `definitions`
// is only consulted by restart(), which resolves stored runs by name.
const enqueueClient = createWorkflowRuntimeClient({
  ...runtime,
  definitions: [publishWorkflow, embedTask],
})

const run = await client.start(
  publishWorkflow,
  { draftId: 'd1' },
  {
    tags: { draftId: 'd1' },
    idempotencyKey: ['content.publish', 'd1'],
  },
)
await client.get(run.id) // full run snapshot (nodes, attempts, children)
await client.cancel(run.id)
await client.list({ tags: { draftId: 'd1' } })
```

### Redis / Valkey runtime

The Redis runtime has the same workflow client and worker interfaces, but a
different operational contract. The caller owns an `ioredis` or `iovalkey`
command client and must configure individual commands to fail in bounded time:

```ts
import { Redis } from 'ioredis'
import { createRedisWorkflowRuntime } from '@nmtjs/workflows/redis'

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2_000,
})

const runtime = createRedisWorkflowRuntime({
  client: redis,
  keyPrefix: 'chat-workflows:',
  terminalRetentionMs: 15 * 60 * 1_000,
})
```

These limits do not disable reconnecting. The client may continue reconnecting
for future work, while the promise for one workflow operation rejects after its
bounded retry/timeout policy. Without a command timeout, an unresponsive socket
can leave the operation pending for the transport's much longer failure window.
With `maxRetriesPerRequest: null`, queued commands may wait across an unlimited
reconnect cycle. Do not use that setting for this runtime.

Treat a timeout or connection error as ambiguous: Redis may have committed the
atomic script before the response was lost. Retry the same high-level workflow
operation with the same idempotency identity; the runtime's deduplication,
start markers, leases, and fencing resolve the replay. Do not retry individual
raw Redis commands outside the runtime.

The example values are safe starting points, not universal latency targets.
Choose finite values that cover the deployment's normal network latency and
failover window. A longer failover budget should increase the finite timeout,
not replace it with unlimited request retries.

Redis-specific constraints:

- Pub/Sub is only a wake hint; polling durable hashes and sorted sets remains
  the correctness fallback.
- Active run families have no TTL. `terminalRetentionMs` starts only after the
  whole root family is terminal and bounds historical memory.
- Shared APIs retain `Date` objects; Redis stores runtime timestamps as Unix
  milliseconds and uses server time for leases and retention. Application
  payloads remain opaque JSON through Lua transitions.
- Queue scans and maintenance reclaim commands after their family expires;
  keep workers or maintenance running to clean up shared queue records.
- Recurring/cron schedules are intentionally unsupported; use Postgres for
  scheduled and ordinary background work.
- Use a unique `keyPrefix`, a `noeviction` memory policy, and deployment-level
  AOF/RDB persistence appropriate to the required restart durability.
- Redis Cluster is unsupported because atomic scripts span the runtime
  namespace. Standalone and Sentinel-managed Redis/Valkey are supported.
- `runtime.dispose()` closes only its duplicated Pub/Sub client. The caller
  must close the command client.

Read models (payload-free, built for UI lists/graphs — `get`/`list` return
full payloads, these don't):

- `client.listSummaries(filter?)` - run summaries with node progress counts;
  filter supports `parentRunId: null` for top-level runs only.
- `client.getDetail(runId)` - run + nodes + children + attempts + child-run
  summaries, all without input/output payloads.
- `client.getNode(runId, nodeName)` - single node snapshot (with payloads).
- `client.getFamily(runId)` - whole run tree with origin edges (which
  node/childKey spawned each run).
- `nodeUnits(detail, nodeName)` (inspector) - groups a node's children,
  attempts, and child runs into per-unit view entries.

Management: `client.deleteRun(runId)` deletes a terminal run and its whole
descendant tree; `client.restart(runId)` starts a fresh run from a stored one —
copies input and tags but NOT the idempotency key (the old key still points
at the original run), `options` overrides win. Restart is the only by-name
operation: it maps the stored `workflowName`/`taskName` back to a definition,
so the client needs that name in `definitions` (or a registered
implementation) and fails with a specific error otherwise.

Live updates: `client.watch(runId, { family?, afterEventId?, signal?,
pollIntervalMs? })` returns an `AsyncIterable<StoredRunEvent>` — history from
the cursor, then live status-change events (run/node/child/attempt), ending
after the watched run's terminal event. Plain async generator: `break`,
`iterator.return()`, and `signal` all clean up; a stream-procedure handler
can `return client.watch(runId, { signal })` directly. Caveats: events carry
no payloads (refetch via read models); under concurrent writers intermediate
event delivery is best-effort, but terminal delivery/termination is
guaranteed. Pull-style access: `store.listRunEvents({ runId, family?,
afterEventId?, limit? })`.

Operational client surface: `pruneRuns(...)` deletes terminal run trees in
batches (retention), `listDeadCommands()` / `requeueDeadCommand(id)` manage
poison commands that exhausted delivery attempts. Retention and dead-letter
requeue are opt-in application concerns.

Low-latency wake-ups (optional, recommended in production):
`createPostgresWorkflowWakeEvents({ connect })` opens a dedicated LISTEN
connection; pass the result as `wakeEvents` to
`createPostgresWorkflowRuntime`. Command dispatch, cancellation, and
`watch()` then react via NOTIFY instead of waiting out poll intervals —
purely a latency hint, polling remains the correctness fallback.

For unit tests use `createInMemoryWorkflowRuntime()` from
`@nmtjs/workflows/runtime` instead of Postgres.

The application owns the schema: build tables from
`createSchema()` (`@nmtjs/workflows/postgres/drizzle`) and migrate with the
app's normal tooling; `verifyPostgresWorkflowSchema` checks the live database
against the manifest version at startup.

## Inspector (`@nmtjs/workflows/inspector`)

Framework-agnostic serialization for building workflow UIs over any
transport:

- `serializeWorkflowGraph(definition)` - stable JSON topology (nodes, targets,
  branch/parallel cases, maps) incl. `title`/`description` metadata.
- `serializeWorkflowCatalog({ workflows?, tasks? })` - "what exists" listing.
- `to*Dto` mappers (`toRunSummaryDto`, `toRunDetailDto`, `toRunSnapshotDto`,
  `toRunEventDto`, ...) - wire-safe counterparts of runtime values: `Date`
  fields become ISO strings, everything else passes through. Types are the
  `*Dto` / `WireSafe<T>` exports.

Caveat: run rows store names only — UIs join runs to graph/catalog by
workflow name; there is no per-run definition snapshot yet.

## Neem runtime integration

A workflows runtime is three files plus a shared config module:

```ts
// neem.runtime.ts
import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

export default createWorkflowsRuntime()({
  name: 'workflows',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})

// neem.planner.ts
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'
import workflowsConfig from './config.ts'

export default defineWorkflowsPlanner(() => workflowsConfig)

// neem.worker.ts
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem'
import workflowsConfig from './config.ts'

export default defineWorkflowsWorker(workflowsConfig)
```

```ts
// config.ts
import { defineWorkflows } from '@nmtjs/workflows/neem'

export default defineWorkflows({
  runtime: createRuntimeAdapter, // async factory returning the runtime
  workflows: () => workflowImplementations,
  tasks: () => taskImplementations,
  workers: {
    coordinator: { threads: 2, concurrency: 2 },
    execution: { threads: 2, concurrency: 4 },
  },
})
```

Worker pool options are `threads`, `concurrency`, `leaseMs`, and
`pollIntervalMs`. The execution pool runs both workflow activities and
standalone tasks. It can instead be an array of named pools with
`activityNames` and/or `taskNames` selectors; one pool may omit both selectors
as the catch-all for work not assigned elsewhere. Worker shutdown aborts
in-flight handlers with reason `shutdown` and releases their commands for
redelivery. Every task and child workflow referenced by a registered workflow
must also have an implementation in `tasks` or `workflows`; startup rejects
incomplete registries before they can create unclaimable work.

`client.retry(runId, { expectedVersion })` retries failed work in the same root
run. Preserve the run page, refresh it, and reopen its watch after retry. Completed
nodes and child runs are reused; only failed work receives new attempts, with
stored input and idempotency keys. `expectedVersion` rejects stale UI actions.
Manual retry does not replenish the automatic attempt budget. It reacquires
uniqueness atomically and resets the run timeout epoch (`activeSince`). PostgreSQL
consumers must migrate to schema version 2 as described in the package README.
