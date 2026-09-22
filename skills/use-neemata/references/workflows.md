# Workflows

Use `@nmtjs/workflows` for durable orchestration with at-least-once command
delivery. Handlers must make external side effects idempotent. PostgreSQL suits
scheduled work, SQL inspection and long retention; Redis/Valkey suits work with
bounded history. Use the in-memory runtime for tests.

## Imports and schemas

Use package subpaths, not an umbrella `nmtjs` import:

- `@nmtjs/workflows`: `defineTask`, `defineWorkflow`, `defineSchedule`,
  `implementTask`, `implementWorkflow`, `toStoredJsonSchema` and contract types.
- `@nmtjs/workflows/runtime`: `createWorkflowRuntimeClient`,
  `createInMemoryWorkflowRuntime`, worker loops, handler runner and adapter types.
- `@nmtjs/workflows/effect`: Effect contract/implementation builders, handler
  runtime and worker wrappers; optional peer `effect` is exactly
  `4.0.0-rc.116`.
- `@nmtjs/workflows/postgres`, `/postgres/drizzle`, `/postgres/testing`:
  see [PostgreSQL](postgres.md) for clients, migrations and ownership.
- `@nmtjs/workflows/redis`: `createRedisWorkflowRuntime`,
  `WorkflowRedisClient`, `CreateRedisWorkflowRuntimeParams`,
  `RedisWorkflowRuntime`.
- `@nmtjs/workflows/inspector`: graph/catalog serialization and `nodeUnits`.
- `@nmtjs/workflows/neem`: runtime factory, planner and Promise worker;
  `@nmtjs/workflows/effect/neem`: Effect worker.

Core schemas implement Standard Schema. Handlers, input mappers, `finish` and
`client.start` use the schema's decoded output type; storage uses JSON.

- A single schema validates in both directions. The compile-time check rejects
  it when its output type is not assignable to its input type.
- For a different stored representation, pass a `{ decode, encode }` pair:
  `decode` validates stored data into the application value; `encode` validates
  the application value into its stored form. For example, a `Date` needs a
  string/date pair; declaring `z.date()` alone does not make it JSON.
- Validation must be synchronous. Encoded values must be JSON, including finite
  numbers; `undefined` is absence, distinct from a present JSON `null`.
- `toStoredJsonSchema(schema, options?)` reads the stored/input JSON Schema,
  defaulting to `draft-2020-12`; returns `undefined` without Standard JSON
  Schema support.
- Shared codecs and validation live in `@nmtjs/common`; custom schema adapters
  can use the root's `createContract`.

## Contracts and implementations

Definitions contain schemas and topology, not handlers or placement. Finish
workflow builders with `.build()`. Implementations bind each node in declaration
order, then `.finish(...)`; pass the exact referenced definition object.

```ts
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'
import * as z from 'zod'

export const decorate = defineTask({
  name: 'content.decorate',
  input: z.string(),
  output: z.string(),
  retry: { attempts: 3, backoff: 'exponential', delay: '1s' },
  timeout: '30s',
})

export const prepare = defineWorkflow({
  name: 'content.prepare',
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
})
  .activity('clean', { input: z.string(), output: z.string() })
  .task('decorate', decorate)
  .build()

export const decorateImpl = implementTask(decorate, {
  pool: 'content',
  handler: (input, _lifecycle, env: { prefix: string }) => env.prefix + input,
})

export const prepareImpl = implementWorkflow(prepare, { pool: 'content' })
  .clean((input) => input.trim(), {
    // The workflow object is not assignable to this step's string input.
    input: (_outputs, input) => input.text,
  })
  .decorate(decorate, { input: ({ clean }) => clean })
  .finish(({ decorate }) => ({ text: decorate }))
```

Builder rules:

- Node names must match `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`, be unique in the
  workflow, and cannot be `input`, `__proto__`, `constructor` or `prototype`.
  Branch case and parallel member keys also reject the last three reserved
  names; the node-name regex does not apply to case keys.
- `.activity(name, { input, output, retry?, timeout? })` is a private step.
  `.task(name, definition, { retry?, timeout? })` references a task;
  overrides take precedence over that task's retry/timeout defaults.
- `.workflow(name, definition, { cancellation? })` starts a child workflow.
  `'propagate'` is the default; `'detach'` leaves the child running when the
  parent is cancelled, fails or times out. The policy is stored on the child
  edge, so cancellation/reaping does not need the implementation registry.
- `.branch(name, { output?, cases: (helpers) => ({ ... }) })` chooses one case.
  Helpers are `activity`, `task`, `workflow`. Without `output`, results are a
  union of case outputs; with it, every case's entire output type must fit.
- `.parallel(name, (helpers) => ({ ... }), metadata?)` runs all members and
  returns a record keyed by member name.
- `.mapTask(name, task, { item, concurrency?, retry?, timeout? })` and
  `.mapWorkflow(name, workflow, { item, concurrency?, cancellation? })` fan
  out to child runs. Supplied concurrency must be a positive integer. Successful
  output is `{ items: { item, index, runId, output }[] }` in input order.
- Parallel and map nodes wait for all children. Failure does not cancel siblings
  or stop pending map admission; the node fails after settlement. No map `mode`.
- Tasks/workflows, nodes and case helpers accept `title` / `description`;
  these affect inspector presentation, not identity or execution.

Implementation rules apply to both core and Effect chains:

- Node input mappers take `(outputs, workflowInput)`. Without one, a node
  receives the workflow input, not the preceding output. A mapper is required
  if the workflow input type is not assignable to the step input type, for
  activity/task/workflow nodes and branch/parallel cases. `any` remains
  permissive.
- Branch implementations take `{ select, cases }`; `select(outputs, input)`
  returns a case key. Parallel implementations take a case object or factory.
  Case factories use `activity(handler, { input })`,
  `task(definition, { input })` or `workflow(definition, { input })`.
  Bare handlers/definitions are allowed only when workflow input fits.
- Map implementations require `{ items, input, idempotency? }`.
  `items(outputs, workflowInput)` returns the item array; per-item input and
  idempotency mappers take `(outputs, item, workflowInput, index)`.
  Ordinary node/case idempotency mappers take `(outputs, workflowInput)`.
- Core task/activity handlers take `(input, lifecycle, env)`; core `finish`
  takes `(outputs, workflowInput, lifecycle, env)`. Both return a value or
  Promise. `finish` runs on a coordinator; keep it quick.
- `env` is one application-owned value satisfying every registered handler
  (`Env<T>` intersects requirements). The engine neither constructs nor
  disposes it. A handler ignoring env contributes no requirement.
- `lifecycle.signal` cooperatively aborts with `WorkflowAttemptAbortError`;
  its `.type` is `timeout`, `leaseLost`, `cancelled` or `shutdown`.
  Late results after an abort are discarded. Attempt timeouts record
  `timedOut` and follow the retry policy; `WorkflowAttemptTimeoutError` is
  also exported from the root.
- Cleanup overruns produce `WorkflowCleanupTimeoutError` from `/runtime`.
  Neem recycles the thread; standalone hosts must handle fatal cleanup.
  Aborting cannot stop arbitrary Promise code that ignores its signal.

Only task and workflow implementations require a named `pool`. Activities run
on their workflow's pool; coordinators advance workflows. Promote an activity
to a task when it needs a different pool, reuse, standalone starts or its own
child-run identity. Retry/timeout options are also available on activities.

## Effect handlers

Import the builders from `@nmtjs/workflows/effect`. They accept synchronous,
service-free `effect/Schema` codecs, including transforms such as
`Schema.DateFromString`. `codec(schema)` derives the JSON encoding pair;
`schemaOf(definition.input)` returns the original schema, or `undefined` for
a schema not created through that adapter. Both helpers are re-exported from
`@nmtjs/common/effect`.

Effect task/activity handlers take `(input, lifecycle)`; Effect `finish`
takes only `(outputs, workflowInput)`. Each returns an Effect; acquire services
through Effect rather than a third argument.

```ts
import {
  defineTask as defineEffectTask,
  implementTask as implementEffectTask,
} from '@nmtjs/workflows/effect'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export const echo = defineEffectTask({
  name: 'content.echo',
  input: Schema.String,
  output: Schema.String,
})
export const echoImpl = implementEffectTask(echo, {
  pool: 'content',
  handler: (input) => Effect.succeed(input),
})
```

- `createHandlerRuntime(context)` produces `HandlerRuntime<R>`, whose
  `run(handler, signal)` runs an Effect in its own scope and returns a Promise
  only after finalizers finish. The core stores this runtime as handler env.
- Interrupt-only failure caused by the signal rethrows `signal.reason`;
  a single ordinary failure/defect keeps its identity. Mixed causes become
  `WorkflowHandlerError`, retaining the Effect `Cause` in `.cause`.
- Effect worker wrappers take `context` instead of `env` and return Promises.
  `Requirements<T>` determines needed services. A core handler can join only
  if the supplied handler runtime satisfies its whole env:
  `[HandlerRuntime<R>] extends [E]`. An env demanding extra properties is
  rejected even if it also extends `HandlerRuntime<R>`.
- Effect Neem workers take one object with `workflows`, optional `tasks` /
  `schedules`, `runtime` and `layer`; see Neem integration below.

## Runtime client

```ts
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
} from '@nmtjs/workflows/runtime'

const memoryRuntime = createInMemoryWorkflowRuntime()
const client = createWorkflowRuntimeClient({
  ...memoryRuntime,
  definitions: [prepare, decorate],
})
const run = await client.start(
  prepare,
  { text: ' hello ' },
  {
    tags: { documentId: 'd1' },
    idempotencyKey: ['prepare', 'd1'],
    startAt: Date.now(),
  },
)
const snapshot = await client.get(run.id)
```

All runtime times are `Timestamp = number`, Unix milliseconds: stored record
fields, `startAt` / `runAt`, filters, scheduling and maintenance clocks.
Application payload Dates are a separate codec concern.

The client does not execute handlers. All operations except `restart` work
without a registry. `start` reads schemas/tags/idempotency/unique from its
definition argument. Optional `workflows` / `tasks` implementation registries
cross-check definition identity and seed restart lookup; `definitions` adds
name lookup without importing implementation code. Distinct definition objects
with the same kind/name are rejected by that index.

Start options: `tags`, `idempotencyKey`, `unique`, `startAt`, and the
PostgreSQL transaction `connection`. Explicit options override definition
builders. Identity rules:

- `idempotencyKey` is an array; replay joins a matching stored run and rejects
  conflicting run data. It is distinct from uniqueness.
- `unique: { key, scope?, behavior? }` constrains root starts. Defaults:
  `scope: 'active'`, `behavior: 'reject'`. Active keys free on terminal
  settlement; `cancelling` still holds them. `'all'` includes retained terminal
  runs. `'join'` returns the conflicting run without comparing input.
- Definition `unique` may be a key function or
  `{ key: (input) => [...], scope?, behavior? }`.
- `WorkflowRunConflictError` from `/runtime` carries `runId`, `status`,
  `key` and `scope`.

Reads return stored JSON, except `start` / `restart`, which decode input and
completed output with the definition:

| Method                   | Result                                                          |
| ------------------------ | --------------------------------------------------------------- |
| `get(id)`                | `RunSnapshot` with run, nodes, children, attempts; or undefined |
| `list(filter?)`          | `{ runs, nextCursor? }`, run rows with payloads                 |
| `listSummaries(filter?)` | Same pagination, payload-free runs with node counts             |
| `getDetail(id)`          | Payload-free run/nodes/children/attempts/child-run summaries    |
| `getNode(id, nodeName)`  | Node, children and attempts with payloads                       |
| `getFamily(id)`          | Root family summaries with node/child-key origin edges          |

`getDetail` / `getNode` return undefined when missing; `getFamily` returns
an empty array. Filters: `kind`, `name`, `status` (one or array),
`activeBefore`, `createdBefore`, `parentRunId` (`null` means roots only),
`rootRunId`, `tags`, `input`, `limit`, `cursor`.

### Cancellation, retry, restart and retention

- `cancel(id)` returns the stored run or undefined. Workflow cancellation
  requests coordination; child workflow settlement takes the child's own lease.
  A leased child may remain cancelling until its continuation runs. Task runs
  have no coordinator and are settled directly. Detached children remain
  cancellable by their own id.
- `retry(id, { expectedVersion? })` reopens a failed root in place without a
  definition registry. It preserves id/input/tags/idempotency and successful
  nodes/children, creates attempts only for failed work, and reuses stored
  attempt input/idempotency. Absolute attempt history stays; manual retry
  replenishes each reopened child's automatic budget and resets its backoff.
  It resets `activeSince` (run timeout epoch), rejects stale versions/live
  leases, and reacquires uniqueness with rejection even for a `join` policy.
  Refresh the same run and open a new watch after retry.
- `restart(id, startOptions?)` accepts terminal roots and resubmits their stored
  input through the current definition. It copies tags and stored uniqueness;
  options override them. It does not copy the stored idempotency key, but the
  definition's idempotency builder still applies: provide a fresh key when a
  genuinely new run is required. Missing name lookup produces an error naming
  the required `definitions` / implementation registry.
- `deleteRun(id)` returns `{ deleted }` and deletes a terminal root's whole
  tree only when descendants are terminal. Detaching does not exempt a live
  descendant from deletion/retention checks.
- `pruneRuns({ olderThan, statuses?, batchSize? })` loops batches until fewer
  than the requested roots are deleted; returns `{ deleted }`. Default batch
  size is 100, statuses are completed/cancelled/failed. Families must be fully
  terminal. Dead commands are age-collected only after being reaped; an
  unreaped command may still be needed to settle its run.
- `listDeadCommands({ runId? }?)` and `requeueDeadCommand(id)` expose
  exhausted command deliveries. Delivery limits are separate from handler
  retry attempts. Retention and manual requeue are application concerns.

### Watch

`watch(id, { wake?, debounceMs?, signal?, pollIntervalMs? })` returns
`AsyncIterable<WatchEvent>`. It emits the current
`{ kind: 'run', status, error? }`, then observed status changes; it ends after
the terminal status or when the run disappears. Missing runs produce no events.
Polling defaults to 1,000 ms. Break/iterator return/abort clean up the watcher.

With `wake: true`, unchanged-status notifications also emit
`{ kind: 'change' }`. These notifications are family-wide, payload-free hints:
refetch detail/node/family as needed. Positive `debounceMs` coalesces them with
leading and trailing yields; zero/omitted disables coalescing. Status discovery,
especially terminal status, is not delayed by debounce.

Intermediate transitions may be missed; polling guarantees terminal discovery
while the run remains stored and the watcher runs. Coarse change events have no
polling backstop. There is no event-history API, `family` option or
`afterEventId` cursor.

## Adapters and standalone workers

All built-in adapters expose `atomicCompletion`. PostgreSQL executes completion
inside a transaction; Redis and in-memory only fence attempt settlement by the
queue claim, then rely on replay of subsequent writes. Handler side effects are
never transactional on any adapter; keep them idempotent.

`createInMemoryWorkflowRuntime({ maxDeliveries? })` supplies an isolated
store/queue, schedules, wake events and `inspect()` for tests; it is not durable.
The PostgreSQL contract is in [PostgreSQL](postgres.md).

Standalone hosts use `runWorkflowWorker` / `runExecutionWorker` to drain
currently claimable work, or `serveWorkflowWorker` / `serveExecutionWorker`
with an abort `signal` for continuous service. Pass the adapter, implementations,
`workerId`, env (or Effect context), and loop settings. Execution workers accept
`pool`; omission serves all registered pools. Low-level idle polling uses
`idleDelayMs`, not the Neem planner's `pollIntervalMs`.

A supervisor can share `createHandlerRunner({ cleanupTimeoutMs?, onFatal? })`
as `handlers` and await `drain()` before disposing env. Standalone workers do
not perform Neem's complete registry validation.

### Redis / Valkey

`WorkflowRedisClient` is structurally satisfied by both `ioredis` and
`iovalkey`. The application owns the command client and configures finite
`maxRetriesPerRequest` and `commandTimeout` values.

```ts
import { Redis } from 'ioredis'
import { createRedisWorkflowRuntime } from '@nmtjs/workflows/redis'

const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  commandTimeout: 2_000,
})
const redisRuntime = createRedisWorkflowRuntime({
  client: redis,
  keyPrefix: 'content-workflows:',
  terminalRetentionMs: 15 * 60 * 1_000,
  maxDeliveries: 20,
})
```

These are deployment-tuned examples, not mandatory latency targets. The complete
factory options are `client`, `keyPrefix` (default `'nmtjs:workflows:'`),
`terminalRetentionMs` (default 900,000), and `maxDeliveries` (default 20).
The last two must be positive safe integers.

- Reconnection may continue for future commands, but each request must settle
  within finite limits; do not use `maxRetriesPerRequest: null`.
- Timeout/connection errors are ambiguous: Redis may have committed already.
  Retry the high-level operation with the same idempotency identity, not raw
  commands outside the runtime.
- Scripts recover from `NOSCRIPT` / `SCRIPT FLUSH` by reloading and retrying.
  Pub/Sub only wakes workers/watchers; durable hashes/sorted sets and polling
  provide execution recovery.
- Active families have no TTL. Retention starts once the entire root family,
  including detached children, is terminal. Redis server time controls leases
  and retention; payloads remain opaque JSON.
- Routed polling and periodic retention maintenance reclaim expired-family
  commands and indexes, including abandoned routes. Configure standalone
  worker `retention` or call `pruneRuns` periodically.
- Delayed starts and retry backoff work; recurring schedules do not.
- Use isolated prefixes, `noeviction`, and deployment persistence/replication
  suitable for the workload. Service-restart durability depends on AOF/RDB,
  not the workflow API. Redis Cluster is unsupported; use standalone or
  Sentinel-managed Redis/Valkey.
- `redisRuntime.dispose()` closes only its duplicated Pub/Sub client, falling
  back to `disconnect()` if `quit()` fails. Close the command client yourself.

## Schedules and inspector

`defineSchedule({ name, runnable, input, cron?, every?, tags?, enabled?,
immediately? })` comes from the root, including for Effect-defined targets.
Exactly one valid `cron` or positive `every` is required; enabled defaults to
true. PostgreSQL and in-memory runtimes expose `scheduler`: reconcile definitions,
then fire due slots through a coordinator or standalone worker scheduling.
Client management is `schedules.list()`, `schedules.trigger(name)`,
`schedules.setEnabled(name, enabled)`; all reject without adapter support.
Manual triggers have independent identities; recurring slots deduplicate.

Inspector exports `serializeWorkflowGraph(definition)`,
`serializeWorkflowCatalog({ workflows?, tasks? })`, and
`nodeUnits(detail, nodeName)`. They expose topology/presentation metadata and
group children/attempts/child runs for UIs. Runs/read models are already JSON
with numeric times: no DTO conversion. Stored runs reference names, not
definition snapshots or versions; join to the current catalog deliberately.

## Neem integration

Use separate runtime, planner and worker modules, default-exporting the results
shown below. The planner runs on the main thread without application imports;
registry factories and setup run in each worker thread.

```ts
import {
  createWorkflowsRuntime,
  defineWorkflowsPlanner,
  defineWorkflowsWorker,
} from '@nmtjs/workflows/neem'
import { Pool } from 'pg'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'

// neem.runtime.ts
const workflowsRuntime = createWorkflowsRuntime()({
  name: 'workflows',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})

// neem.planner.ts
const planner = defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1, concurrency: 2 },
  pools: { content: { threads: 2, concurrency: 4 } },
}))

// neem.worker.ts
const worker = defineWorkflowsWorker({
  workflows: () => [prepareImpl],
  tasks: () => [decorateImpl],
  setup: async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      const connection = createPostgresWorkflowConnection(pool)
      await verifyPostgresWorkflowSchema(connection)
      return {
        runtime: createPostgresWorkflowRuntime({ connection }),
        env: { prefix: 'Prepared: ' },
        dispose: () => pool.end(),
      }
    } catch (error) {
      // Setup owns acquisitions until it returns resources to the worker.
      await pool.end()
      throw error
    }
  },
})
```

- Core worker options are `workflows: () => implementations`, optional
  `tasks` / `schedules` factories, and `setup(ctx)`. Factories/setup may be
  asynchronous. Setup returns `{ runtime, env?, dispose? }`; env is required
  when handlers need it and must satisfy the entire registry.
- `ctx.data` has `role: 'coordinator' | 'execution'`, optional `pool`,
  `settings` and declared `pools`. Size resources per thread.
- Both coordinator and named pools accept `threads`, `concurrency`,
  `leaseMs`, `pollIntervalMs`, `cleanupTimeoutMs`. Defaults respectively:
  1, 1, 30,000, 250, 5,000. Threads must be positive integers; declare at
  least one nonempty pool name. Concurrency is per worker loop/thread and
  multiplies with threads and application instances, not a cluster limit.
- Startup rejects undeclared implementation pools, missing referenced
  task/workflow implementations, two distinct implementations for one name,
  conflicting definition objects and missing/mismatched schedule targets.
  Repeated references to the same implementation object are deduplicated.
  References and implementations share the same definition object.
- Coordinators reconcile schedules and own maintenance; execution threads
  serve their named pool. Redis coordinators reject nonempty schedules.
- Shutdown stops claims, aborts handlers with `shutdown`, joins loops, drains
  handlers, disposes the runtime, then calls resource `dispose` even if adapter
  disposal failed. Shutdown releases commands for redelivery.
- Cleanup deadlines cover handler drain and resource disposal. A timeout
  reports fatal failure for thread recycling; it does not authorize disposing
  env still in use. Neem's 30,000 ms worker readiness timeout bounds `setup`.

Effect workers use `defineWorkflowsWorker` from
`@nmtjs/workflows/effect/neem` with the same registry factories and planner.
`runtime` is an `Effect<WorkflowRuntimeAdapter, unknown, R | Scope>`;
`layer` must supply all handler and runtime requirements except `Scope`, which
the worker provides. Layer is optional only when no services are needed.
The worker disposes the runtime before closing the Layer after handlers drain.
Its cleanup timer is armed when main exits, before scope finalizers, including
startup failures after acquisition.
Neem's outer stop deadline is 5,000 ms; a larger `cleanupTimeoutMs` does not
extend it.
