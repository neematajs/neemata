# Workflows

Use `@nmtjs/workflows` for durable, contract-first orchestration: multi-step
processes that must survive crashes, retry safely, fan out to child runs, and
be observable/cancellable by id. Runs are persisted (Postgres in production),
executed by coordinator and execution workers with at-least-once command
delivery and exactly-once state transitions.

Import rules (no `nmtjs` umbrella exports; always package subpaths):

- `@nmtjs/workflows` - contracts (`defineTask`, `defineWorkflow`) and
  implementations (`implementTask`, `implementWorkflow`), public types. The
  core is Effect-free: Standard Schemas, Promise handlers, one `env` value.
- `@nmtjs/workflows/effect` - the same four functions over `effect/Schema`
  schemas and Effect handlers, plus Effect worker functions. Needs the optional
  `effect` peer. `@nmtjs/workflows/effect/neem` has the Effect Neem worker.
- `@nmtjs/workflows/runtime` - `createWorkflowRuntimeClient`,
  `createInMemoryWorkflowRuntime`, worker loops, store/adapter types.
- `@nmtjs/workflows/postgres` - `createPostgresWorkflowConnection`,
  `createPostgresWorkflowRuntime`, `verifyPostgresWorkflowSchema`,
  `WORKFLOW_POSTGRES_SCHEMA_VERSION`.
- `@nmtjs/workflows/postgres/drizzle` - `createSchema()` so the application
  owns the tables and migrations.
- `@nmtjs/workflows/postgres/testing` - schema bootstrap helpers for tests.
- `@nmtjs/workflows/inspector` - UI-facing serialization: workflow graph/
  catalog JSON, wire-safe DTOs, node unit grouping.
- `@nmtjs/workflows/neem` - Neem runtime integration
  (`createWorkflowsRuntime`, `defineWorkflowsPlanner`, `defineWorkflowsWorker`).

## Contracts

Tasks are standalone durable units; workflows are DAGs of named nodes built
with a fluent builder and finished with `.build()`. Schemas are
[Standard Schemas](https://standardschema.dev) (Zod, Valibot, ArkType, ...).

```ts
import { defineTask, defineWorkflow } from '@nmtjs/workflows'
import { z } from 'zod'

export const embedTask = defineTask({
  name: 'content.embed',
  input: z.object({ entityId: z.string(), text: z.string() }),
  output: z.object({ embeddingId: z.string() }),
  retry: { attempts: 3, backoff: 'exponential' },
  timeout: '30s',
  tags: (input) => ({ entityId: input.entityId }),
  idempotency: (input) => ['content.embed', input.entityId],
})

export const publishWorkflow = defineWorkflow({
  name: 'content.publish',
  input: z.object({ draftId: z.string() }),
  output: z.object({ url: z.string() }),
})
  .activity('render', {
    input: z.object({ draftId: z.string() }),
    output: z.object({ html: z.string() }),
  })
  .task('embedding', embedTask)
  .build()
```

Schema rules:

- A single schema serves values stored as they are; it validates on write and
  again on read. Handlers, clients and results see its output type.
- A transformed value (stored string, `Date` in handlers) declares both
  directions: `{ decode: StandardSchema<stored, Type>, encode:
StandardSchema<Type, stored> }`. A lone transforming schema is a compile error.
- Validation must be synchronous and whatever is stored must be JSON.
- `toStoredJsonSchema(definition.input)` returns the stored form's JSON Schema
  when the library implements Standard JSON Schema.

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

`implementTask(definition, { pool, handler })`; workflow implementations start
with `implementWorkflow(definition, { pool })`, chain one method per node name
and end with `.finish(...)`. Mapper callbacks receive `(outputs, input)` where
`outputs` holds prior node results.

```ts
import { implementTask, implementWorkflow } from '@nmtjs/workflows'

type Env = { embedder: Embedder; renderer: Renderer }

export const embedTaskImpl = implementTask(embedTask, {
  pool: 'ml',
  // (input, lifecycle, env). lifecycle.signal aborts with a
  // WorkflowAttemptAbortError whose .type is timeout/leaseLost/cancelled/shutdown
  handler: async (input, lifecycle, env: Pick<Env, 'embedder'>) => ({
    embeddingId: await env.embedder.embed(input.text, lifecycle.signal),
  }),
})

export const publishWorkflowImpl = implementWorkflow(publishWorkflow, {
  pool: 'content',
})
  .render(
    async (input, _lifecycle, env: Pick<Env, 'renderer'>) => ({
      html: await env.renderer.render(input.draftId),
    }),
    { input: (_outputs, input) => input },
  )
  .embedding(embedTask, {
    input: ({ render }, input) => ({
      entityId: input.draftId,
      text: render.html,
    }),
  })
  .finish(({ embedding }, input) => ({
    url: `/published/${input.draftId}?emb=${embedding.embeddingId}`,
  }))
```

Rules:

- Dependencies are one `env` value, the handler's third argument, typed per
  handler. The worker must pass an env that satisfies every registered handler
  at once; the engine neither builds nor disposes it. `finish` receives
  `(outputs, workflowInput, lifecycle, env)`, runs on a coordinator and must be
  quick.
- Handlers run at-least-once; make side effects idempotent and use the
  `idempotency` key builders to deduplicate task/child runs.
- Branch nodes take `{ select, cases }`; map nodes take
  `{ items, input, idempotency? }` with per-item mappers
  `(outputs, item, input, index)`.
- Cancellation is cooperative: handlers that ignore `lifecycle.signal` run to
  completion, their result is never committed, and one that outlives the
  cleanup deadline recycles its worker thread. `signal.reason` is a
  `WorkflowAttemptAbortError` (exported from the root) with `.type`.
- Timed-out attempts record status `timedOut` and follow the retry policy;
  `WorkflowAttemptTimeoutError` is exported from the root.

### Task or activity?

Only tasks and workflows carry placement: each names the execution `pool` whose
workers run it, and nothing is placed implicitly. An activity is a private step
of its workflow and runs on the workflow's pool; it has no placement options.

- Use an **activity** for a step that belongs to one workflow and can share its
  pool: glue, lookups, assembling data.
- Use a **task** when a step needs its own pool (heavy or risky work such as
  rendering, ML, anything with unreliable cleanup), its own retry/timeout
  policy or identity, reuse across workflows, or to be started on its own. A
  task used as a node or map item is a child run, visible in the inspector.

Promoting a step to a task is the way to isolate it. Pool names are declared
and sized by the Neem planner; an implementation that names an undeclared pool
fails worker startup.

### Effect applications

Import `defineTask`, `defineWorkflow`, `implementTask`, `implementWorkflow`
from `@nmtjs/workflows/effect` instead. Schemas are `effect/Schema` (transforms
such as `Schema.DateFromString` need no pair), handlers and `finish` return
Effects and take `(input, lifecycle)` / `(outputs, workflowInput)`, and services
come from the worker's Layer. `pool` works the same. `schemaOf(definition.input)`
returns the declared Effect schema.

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

A workflows runtime is three files:

```ts
// neem.runtime.ts
import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

export default createWorkflowsRuntime()({
  name: 'workflows',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})

// neem.planner.ts — deployment layout; imports no application code
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 2, concurrency: 2 },
  pools: {
    content: { threads: 2, concurrency: 4 },
    ml: { threads: 1, concurrency: 1, cleanupTimeoutMs: 1_000 },
  },
}))

// neem.worker.ts — application; setup runs once per worker thread
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem'

export default defineWorkflowsWorker({
  workflows: () => workflowImplementations,
  tasks: () => taskImplementations,
  schedules: () => schedules,
  setup: async (ctx) => {
    const pool = new Pool({ connectionString: databaseUrl })
    return {
      runtime: createPostgresWorkflowRuntime({
        connection: createPostgresWorkflowConnection(pool),
      }),
      env: { embedder, renderer }, // checked against every handler's env
      dispose: () => pool.end(),
    }
  },
})
```

Pool and coordinator options are `threads`, `concurrency`, `leaseMs`,
`pollIntervalMs` and `cleanupTimeoutMs`. Coordinator threads advance runs and
own schedules and maintenance; a pool's threads run the tasks, and the
activities of the workflows, implemented for that pool. Pool `concurrency` is
per-process capacity, not a cluster-wide limit. Every pool an implementation
names must be declared; there is no default pool. `ctx.data` names the thread's
role and pool for a `setup` that needs different resources per pool.

Worker shutdown stops claims, aborts in-flight handlers with reason `shutdown`,
waits for them, then disposes the adapter and calls `dispose`; aborted commands
are redelivered. Every task and child workflow referenced by a registered
workflow must also have an implementation in `tasks` or `workflows`; worker
startup rejects incomplete registries before they can create unclaimable work. It
also rejects a name carried by more than one definition object: references and
implementations must share one definition, which also rules out cycles. For
recurring work use schedules, not recursion.

Effect applications use `defineWorkflowsWorker({ workflows, tasks, schedules,
layer, runtime })` from `@nmtjs/workflows/effect/neem` with the same planner;
the Layer must provide every handler's services.

`client.retry(runId, { expectedVersion })` retries failed work in the same root
run. Preserve the run page, refresh it, and reopen its watch after retry. Completed
nodes and child runs are reused; only failed work receives new attempts, with
stored input and idempotency keys. `expectedVersion` rejects stale UI actions.
Manual retry does not replenish the automatic attempt budget. It reacquires
uniqueness atomically and resets the run timeout epoch (`activeSince`). PostgreSQL
consumers must migrate to schema version 2 as described in the package README.
