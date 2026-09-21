# @nmtjs/workflows

Typed workflow and task primitives for Neemata.

## Imports

The core is Effect-free: definitions take Standard Schemas, handlers return values
or Promises, and the worker passes them one `env` value.

```ts
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'
```

`@nmtjs/workflows/effect` exports the same four functions for Effect
applications: definitions take `effect/Schema` schemas, and handlers return
Effects whose services come from the worker. It needs the optional `effect` peer,
pinned to `4.0.0-rc.116`, as does the Effect worker in
`@nmtjs/workflows/effect/neem`. Applications and the package must use this exact version during the
release-candidate period; only stable Effect modules are imported. Definitions
and implementations from either entry point are interchangeable everywhere else.

Runtime adapters live behind explicit subpaths:

```ts
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'
import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
import { createRedisWorkflowRuntime } from '@nmtjs/workflows/redis'
```

## Schemas, handlers and env

Definitions take [Standard Schemas](https://standardschema.dev), so any library
that implements the spec works: Zod, Valibot, ArkType, or Effect through the
adapter below. Handlers, clients and results see a schema's output type; stores
see JSON. Schemas must validate synchronously.

A single schema serves values that are stored as they are: it validates them on
the way in and again when they are read back. Standard Schema validates in one
direction only, so a transformed value declares both directions, and a single
transforming schema is rejected at compile time.

```ts
import * as z from 'zod'

const date = {
  decode: z.iso.datetime().transform((stored) => new Date(stored)),
  encode: z.date().transform((value) => value.toISOString()),
}

const normalizeDate = defineTask({
  name: 'normalize-date',
  input: z.object({ at: z.string() }),
  output: date,
})

const implementation = implementTask(normalizeDate, {
  handler: async ({ at }, lifecycle, env: { clock: Clock }) =>
    env.clock.round(new Date(at)),
})

await runExecutionWorker({
  ...runtime,
  env: { clock },
  workflows: [],
  tasks: [implementation],
  workerId: 'worker-1',
})
```

Whatever a schema produces must be JSON when it is stored; the engine checks.
`toStoredJsonSchema(definition.input)` returns the JSON Schema of the stored form
when the library implements Standard JSON Schema, for code generation and tooling.

Dependencies are that one `env` value. The engine neither builds nor disposes
it: its owner creates it before starting the worker and disposes it afterwards.
The worker input requires an `env` that satisfies every registered handler at
once; handlers that ignore it require none. Workflow `finish` receives
`(outputs, workflowInput, lifecycle, env)`. `createContract` builds definition
functions for a library whose schemas are not Standard Schemas themselves.

## Pools: tasks, workflows and activities

Only tasks and workflows carry placement. Each names the execution pool whose
workers run it, and nothing is placed implicitly:

```ts
implementTask(renderPdf, { pool: 'pdf', handler })

implementWorkflow(checkout, { pool: 'checkout' }) // its activities run here
  .price(loadPrice) // activity: inherits the pool
  .receipt(renderPdf, { input: ({ price }) => price }) // task node: pdf pool
  .finish(({ receipt }) => receipt)
```

An activity is a private step of its workflow and has no placement options. A
step that needs its own pool, because it is heavy, risky to clean up, or has to
be isolated from the rest, should be a task: a task can be a node or a map item,
has its own retry and timeout policy, and is its own run in the inspector.
Promoting a step to a task is how it gets isolated, and that decision is then
visible in the contract. The workflow itself is advanced by coordinator threads,
so `finish` must be quick.

A pool is only a name here; its size and timing are a deployment decision made
by the planner. Workers claim the tasks, and the activities of the workflows,
implemented for their pool. Routing is decided by workers, not stamped on queued
work, so moving an implementation to another pool takes effect for already
queued work on the next deploy. A standalone worker takes
`runExecutionWorker({ pool: 'pdf', ... })`; without `pool` it serves everything.

Pool `concurrency` is capacity per process, not a limit: three instances of a
pool with two slots run six handlers. Cluster-wide limits are not implemented.

## Neem integration

The planner owns the thread layout. It runs on the main thread and imports no
application code:

```ts
// app.planner.ts
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1, concurrency: 4 },
  pools: {
    checkout: { concurrency: 8 },
    pdf: { threads: 2, concurrency: 1, cleanupTimeoutMs: 1_000 },
  },
}))
```

Each pool and the coordinator take `threads`, `concurrency`, `leaseMs`,
`pollIntervalMs` and `cleanupTimeoutMs`. Coordinator threads advance runs and own
schedules and maintenance; pool threads run handlers. Every pool an
implementation names must be declared here; there is no default pool. Every
thread receives its settings and the declared pool names from the planner.

The worker definition is the application side, and `setup` runs once per thread:

```ts
// app.worker.ts
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem'

export default defineWorkflowsWorker({
  workflows: () => [checkoutImpl],
  tasks: () => [renderPdfImpl],
  schedules: () => [nightly],
  setup: async (ctx) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    return {
      runtime: createPostgresWorkflowRuntime({
        connection: createPostgresWorkflowConnection(pool),
      }),
      env: { db: pool, log: ctx.logger }, // checked against every handler's env
      dispose: () => pool.end(),
    }
  },
})
```

Startup fails when an implementation names a pool the planner did not declare,
when a workflow references a child workflow or task with no registered
implementation, or when one name is carried by more than one definition object.
Children and tasks resolve by name, so a same-named copy would be encoded with
one schema and decoded with another; it is also the only way workflows could
start each other in a cycle, since definitions cannot reference each other.
Share one definition module between a reference and its implementation. An
implementation listed more than once is deduplicated. `ctx.data` names the thread's role and pool, for a `setup` that
needs different resources per pool.

On stop the worker stops claiming, aborts attempts, joins the loops, waits for
every handler to settle, and only then disposes the adapter and calls `dispose`.
A handler that outlives the pool's `cleanupTimeoutMs` fails `finished`, so Neem
recycles the thread, and the env is not disposed while that handler still runs. A
stop during `setup` waits for it and disposes what it acquired. Effect
applications use the worker in `@nmtjs/workflows/effect/neem`; see below.

## Effect schemas

With `@nmtjs/workflows/effect`, contracts use `effect/Schema`:

```ts
import { defineTask, implementTask } from '@nmtjs/workflows/effect'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const normalizeDate = defineTask({
  name: 'normalize-date',
  input: Schema.DateFromString,
  output: Schema.DateFromString,
})

const implementation = implementTask(normalizeDate, {
  handler: (date) => Effect.succeed(date),
})
```

Effect schemas are not Standard Schemas themselves. The adapter stores each one as
a `{ decode, encode }` pair: its `Schema.toCodecJson` form and the same codec flipped,
both through Effect's Standard Schema and Standard JSON Schema converters.
`schemaOf(definition.input)` returns the declared Effect schema, for composing
schemas from existing definitions.

Every typed programmatic API takes and returns decoded **Type**: `client.start`
input and its returned run input/output, task/activity handlers, workflow finish,
input mappers, map items and per-item inputs, code-defined schedule inputs, and
metadata callbacks. The engine encodes once with the definition's schema (for an
Effect schema, its `Schema.toCodecJson` form) when writing storage/commands/child payloads, and decodes when reading them.
Restart decodes the stored input and calls `start(Type)`. Retry/restart eligibility
is unchanged. Untyped `get`, `list`, `listSummaries`, history and inspector reads
expose stored JSON without definitions. Raw JSON callers decode explicitly with their authored input schema, for example
`Schema.decodeUnknownSync(MyInput)`; there is no `startEncoded` API.

| Schema                    | Type      | Stored JSON |
| ------------------------- | --------- | ----------- |
| `Schema.DateFromString`   | `Date`    | ISO string  |
| `Schema.Date`             | `Date`    | ISO string  |
| `Schema.NumberFromString` | number    | string      |
| `Schema.Undefined`        | undefined | null        |

The undefined-to-null encoding also applies inside structs. For example,
`Schema.optional(Schema.String)` stores an explicitly supplied `a: undefined` as
`"a": null`; an absent `a` key remains absent. Decoding restores the supplied
undefined value, while SQL/history readers see null.

Effect schemas must be synchronous, require no Effect services, and support JSON
encoding. Custom types need a JSON codec supported by Effect's `toCodecJson` derivation.
JSON derivation support is checked when actual values are encoded, not at definition
or worker registration. For example, `Schema.instanceOf(URL)` alone accepts a URL
at the authored boundary but cannot persist it. Test custom codecs with representative
values before deployment; node-level encoding failures can otherwise occur mid-run.
`Schema.Unknown` accepts only JSON-compatible values at persistence boundaries;
use `Schema.Undefined` for an explicit void value. A workflow without an output
schema may return JSON or finish without a value; rich outputs require a schema.
Encoding and decoding failures use the existing workflow failure/retry paths.

Plain JSON contracts retain their payload representation. Transformed contracts
can differ from the old decoded-value-then-`JSON.stringify` representation: for
example, `NumberFromString` persists a string rather than a number. Stored-data
compatibility must therefore be assessed before deployment. At cutover, pause new
starts and schedule firing, drain old runs and their children, and stop old workers
before enabling new writers. Re-entry decode failures are terminal. Retained history
needs a separate compatibility check before resubmission; draining does not convert
it. This slice adds no format marker, history restriction, or retry/restart ban.

## Effect execution and services

This section describes `@nmtjs/workflows/effect` and the Neem integration. Use
`Effect.gen`, `Effect.tryPromise`, or other Effect constructors in task/activity
handlers and workflow `finish`. Dependency dictionaries, core Containers, plugins,
and the old execution environment are removed. Resolve services by yielding a
`Context.Service` inside an Effect. Callback signatures no longer have a `ctx`
argument. Synchronous input/select/items/idempotency callbacks use their explicit
arguments or immutable closure values; keep them deterministic and brief.
`finish` runs during coordination and should assemble the result; put long-running
or retryable work in a task/activity.

| Callback                                                    | Arguments                               |
| ----------------------------------------------------------- | --------------------------------------- |
| Task/activity handler                                       | `(input, lifecycle)`                    |
| `finish`, node `input`, `select`, `items`, node idempotency | `(outputs, workflowInput)`              |
| Map `input` and map idempotency                             | `(outputs, item, workflowInput, index)` |

Arguments and returned values use decoded schema types. Handlers and `finish`
return Effects; synchronous callbacks return values directly.

```ts
import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import { defineWorkflowsWorker } from '@nmtjs/workflows/effect/neem'
import { createInMemoryWorkflowRuntime } from '@nmtjs/workflows/runtime'

class Prefix extends Context.Service<Prefix, string>()('Prefix') {}

const greet = defineTask({
  name: 'greet',
  input: Schema.String,
  output: Schema.String,
})
const greeting = implementTask(greet, {
  handler: (name) =>
    Effect.gen(function* () {
      const prefix = yield* Prefix
      return `${prefix}, ${name}`
    }),
})

export default defineWorkflowsWorker({
  workflows: () => [],
  tasks: () => [greeting],
  layer: Layer.succeed(Prefix, 'Hello'),
  runtime: Effect.sync(createInMemoryWorkflowRuntime),
})
```

`runtime` is an Effect that acquires the adapter; it may use the same Layer and
`Effect.acquireRelease` for database connections. A production worker uses a shared
durable adapter. The in-memory adapter above is only a single-worker example.
`defineWorkflowsWorker` checks that the Layer provides services
required by the adapter, task/activity handlers (including branch/parallel cases),
and finish. The Layer must not require external services. The worker supplies
Scope for adapter acquisition, and each handler gets its own Scope.

For attempts, typed failures and defects both use the existing retry policy.
An `Effect.promise` rejection is a defect and still counts as a failed attempt.
An interruption without an engine abort reason also counts as a failure.
Engine cancellation, timeout, shutdown and lease loss keep their existing
classification. The second handler argument is always supplied, even if your
handler only declares `input`. On abort, `lifecycle.signal.reason` is a
`WorkflowAttemptAbortError` with the engine's reason. Keep this signal when you need
to distinguish cancellation, timeout, shutdown, or lease loss; the signal provided
by `Effect.promise` reflects fiber interruption without that engine classification.
Prefer native Effect interruption and connect cancellable Promise APIs to a signal.

Effect handlers receive a `HandlerRuntime` as their env: it runs a handler with
`runPromiseExitWith` using the worker Context and its AbortSignal. The standalone
Effect worker functions build it from `context`; a supervisor that drains handlers
itself passes `env: createHandlerRuntime(context)` and a shared
`handlers: createHandlerRunner(...)` to the core worker functions. Single failures keep the existing StoredError representation;
mixed Causes retain their rendered failure and finalizer information. There are
no persisted typed-error codecs yet. Workflow finish failures retain the existing
terminal-run behavior, rather than gaining an activity retry policy.

On shutdown, the worker stops claims, aborts user Effects, and joins engine work
and handler finalizers before disposing the adapter and Layer. Handler and
worker-scope cleanup are bounded by the pool's `cleanupTimeoutMs` (default
5,000 ms). An overrun fails the runtime's `finished` promise so Neem recycles the
thread; it does not release shared services while a handler still uses them.
Recycling also interrupts healthy sibling attempts on that thread; they are
redelivered through the existing expired-lease path. Keep finalizers short and
isolate handlers with risky cleanup in separate execution pools. Result commits
still use the engine's attempt/run fencing even when a handler has already succeeded.

On a requested stop, Neem enforces a separate hard 5,000 ms deadline for the whole
worker. Setting `cleanupTimeoutMs` above 5,000 cannot extend that deadline, and
`finished` failures after a stop request do not trigger recovery. Budget handler,
adapter, and Layer cleanup together to finish within the host deadline; otherwise
Neem terminates the thread, including on deploy. A stop during startup reaches
`runtime.stop()` once the worker factory has resolved, without waiting for readiness.
Factory completion and finalizers share the host deadline. Configurable host
deadlines remain separate lifecycle work.

Interruption cannot stop Promise work that ignores cancellation. Such work can
continue after its fiber exits, so integrate its AbortSignal or arrange explicit
cleanup. An uninterruptible effect/finalizer remains owned by its fiber and can
require thread termination. Hosts using the lower-level worker loops directly
must handle cleanup-overrun failures by terminating their execution environment;
`defineWorkflowsWorker` supplies that supervision through Neem.

## Redis / Valkey Runtime

Use the Redis runtime as a separate hot-path runtime when dispatch latency and
queue throughput matter more than long-term retention or SQL inspection. It
implements the same workflow client and worker APIs as the Postgres and
in-memory runtimes:

```ts
import { Redis } from 'ioredis'
import { createRedisWorkflowRuntime } from '@nmtjs/workflows/redis'
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2_000,
})
const runtime = createRedisWorkflowRuntime({
  client: redis,
  keyPrefix: 'chat-workflows:',
  terminalRetentionMs: 15 * 60 * 1000,
})
const workflows = createWorkflowRuntimeClient(runtime)
```

The runtime also accepts an `iovalkey` client. Queue transitions use SHA-loaded
Lua scripts for atomic deduplication, claiming, lease fencing, acknowledgement,
retry/dead-letter movement, and stalled-claim recovery. Pub/Sub is only a wake
hint; sorted sets and hashes remain the durable execution state, so a missed
notification falls back to polling.

Workflow families are partitioned into small per-family hashes for runs, nodes,
children, attempts, leases, and indexes. Each state transition validates and
updates only the affected hash fields in one atomic Lua operation; the runtime
does not hold distributed locks or perform client-side compare-and-swap retry
loops.

Runtime timestamps are Unix milliseconds in Redis, as in every record the
runtime returns. Application payloads are stored as
opaque JSON so Lua transitions preserve empty arrays, numeric precision, and
payload fields that happen to have timestamp names. Lease deadlines and
retention use Redis server time to avoid disagreement between worker clocks.

Active run families never receive a TTL. Retention starts only when every run
in the root family is terminal, then the complete family and its lookup keys
expire together. This prevents a live child from losing its parent state while
keeping historical runs from filling Redis memory.
Lookup keys reused by a newer run retain that run's ownership. Routed polling
removes expired-family commands when they become due on a worker's routes.
Retention maintenance also sweeps abandoned routes and commands with future
schedules or leases; run `store.pruneTerminalRuns()` periodically, or configure
worker retention, to reclaim those commands and their indexes. The terminal-run
index expires after its latest retained entry.

Delayed starts and retry backoff are supported. Recurring/cron schedules are
intentionally not part of the Redis runtime; use a Postgres runtime for durable
scheduled and background work. A single application can register separate
named Redis and Postgres runtimes and choose between them per workload: each
Neem workflows worker's `setup` (or `runtime` service) returns the adapter its
planner's pools run on.

Ready and claimed commands have route indexes, so polling and lease recovery
inspect only the workflows and tasks of the worker's pool. Claims compare the
oldest due command across the selected routes. Per-run indexes scope manual
retry, cancellation, and family deletion to the affected runs. Lua maintains
these indexes atomically with queue transitions. Manual retry still performs
work proportional to the affected family and its own retained commands;
retention maintenance scans shared queues in bounded batches. Recovery and
command deletion batch work across routes and runs; heartbeats renew the lease
and read run status in one atomic call. Dead-command reads honor limits and
page through retained records.

Run listing uses a chronological index to fetch bounded candidate pages before
applying filters. Summary reads count only the selected runs' nodes in bounded
batches, without downloading their families. The chronological index survives
while active runs exist and expires with the latest retained terminal run when
all families are terminal.

The caller owns the command client and must close it. `runtime.dispose()` closes
only the duplicated Pub/Sub connection. Redis Cluster is not supported in this
version because atomic operations span the runtime namespace; use a standalone
or Sentinel-managed Redis/Valkey deployment with an isolated `keyPrefix`.
Keep command retries and timeouts finite. Reconnecting and completing one
command are separate concerns: the client may continue reconnecting for future
work, while `maxRetriesPerRequest` and `commandTimeout` bound the promise for an
individual workflow operation. Never use `maxRetriesPerRequest: null` here; it
allows a command to remain queued across an unlimited reconnect cycle. A
timeout is ambiguous because Redis may have committed before its response was
lost, so retry the same high-level workflow operation with the same idempotency
identity. Transitions are idempotent or fenced; do not retry raw Redis commands
outside the runtime. The values above are starting points and may be increased
to cover normal deployment latency and failover, but they must remain finite.

Queue durability survives worker and client failures, but recovery after a
Redis/Valkey service restart depends on the deployment's own persistence and
replication configuration. Enable an appropriate AOF or RDB policy for the
workload; the runtime cannot reconstruct data that the service did not persist.
Use a `noeviction` max-memory policy so memory exhaustion fails an operation
explicitly instead of silently evicting one part of a workflow family. Terminal
retention bounds historical state, but capacity must still cover the maximum
concurrent active state and ready/claimed queue backlog.

## Timestamps

Every time the runtime reads or returns is a `Timestamp`: Unix milliseconds, as
`Date.now()` returns them. That covers record fields such as `createdAt`,
`activeSince` and `dispatchedAt`, options such as `startAt`, and list filters such as
`createdBefore`. Runs, snapshots and read models are therefore plain JSON and cross
a transport as they are. PostgreSQL still stores `timestamptz` columns; the adapter
converts at its boundary. `Date`s in your own inputs and outputs are a schema
concern and unaffected.

## Runtime Connection

Runtime code consumes a small `WorkflowPostgresConnection` interface. For
`pg`-style clients and pools, wrap the app-owned client:

```ts
import { Pool } from 'pg'
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
```

Other clients can pass a custom object that satisfies `WorkflowPostgresConnection`.

The client and its type parsers stay yours. The adapter reads `timestamptz` columns
through whatever parser the client has, so that parser must return a `Date` (the
`pg` and PGlite default), the column's text, or Unix milliseconds. Any other value,
such as a `Temporal` object, fails the read with a `TypeError` instead of reaching a
record. Timestamps are written as `Date` parameters, which drivers serialize the same
way regardless of parsers.

## Wake Events (LISTEN/NOTIFY)

Command dispatch and cancellation are poll-based by default: dispatch latency
is bounded by the worker poll interval, cancellation latency by the attempt
heartbeat cadence (`leaseMs / 3`). The Postgres runtime can layer
`LISTEN/NOTIFY` wake-up hints on top so idle workers wake immediately when a
command is enqueued and running attempts observe cancellation right away:

```ts
import { Client, Pool } from 'pg'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  createPostgresWorkflowWakeEvents,
} from '@nmtjs/workflows/postgres'

const wakeEvents = createPostgresWorkflowWakeEvents({
  // dedicated LISTEN connection, one per worker process
  connect: async () => {
    const client = new Client({ connectionString })
    await client.connect()
    return client
  },
})

const runtime = createPostgresWorkflowRuntime({ connection, wakeEvents })
```

Notifications are fire-and-forget hints: a missed one (disconnect, restart)
degrades to the existing polling behavior, never to lost work. With wake
events enabled, generous poll intervals and lease durations keep idle database
traffic low without sacrificing dispatch or stop latency. The tradeoff: every
immediate command enqueue and cancellation adds a `NOTIFY` to its transaction,
and Postgres serializes commits of notifying transactions — under very high
dispatch throughput this can reduce commit parallelism. Delayed commands skip
the hint entirely. The listener
reconnects automatically after connection loss; `wakeEvents.dispose()` runs as
part of `runtime.dispose()`.

## Postgres Schema

Applications own production migrations. The package exports Drizzle schema
objects so apps can include them in their own migration flow:

```ts
const workflows = createSchema()

export const WorkflowRunTable = workflows.tables.runs
export const WorkflowNodeTable = workflows.tables.nodes
export const WorkflowRunKind = workflows.enums.runKind
```

`createSchema()` emits the canonical physical table and enum names required by
the runtime. Custom database object names are not supported yet.

Your migration must also seed the schema version row used by startup
verification:

```sql
INSERT INTO workflow_schema_version (id, version)
VALUES (1, 2)
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version;
```

Use `verifyPostgresWorkflowSchema(connection)` at startup to fail fast when the
installed schema does not match the runtime. The helper
`installPostgresWorkflowSchemaForTesting(connection)` is available from
`@nmtjs/workflows/postgres/testing` for tests and local development only, not
production migrations.

## Retrying failed work

`client.retry(runId, { expectedVersion })` reopens a failed root run in place.
The ID, input, tags, idempotency key, successful nodes and child runs are retained.
Only failed work executes again, using the previous attempt's stored input and
idempotency key. Attempt history and absolute attempt numbers are preserved;
manual retry replenishes the automatic retry budget and resets exponential
backoff for each reopened child. `expectedVersion` is optional, but management
UIs should supply the version they displayed to reject stale retry requests.

`client.restart(runId, options)` creates a new root run from the stored input.
It accepts failed, completed and cancelled roots, plus the same start options
as `start()`. This is the old `retry()` behavior. Definitions are required by
`restart()` for name resolution; in-place `retry()` is registry-free. Existing
uniqueness and idempotency rules still apply to a restart. In-place retry always
rejects an occupied uniqueness key, even when the constraint normally joins.

All `parallel`, `mapTask` and `mapWorkflow` nodes wait for every child to settle.
Failures do not cancel siblings or stop admission of pending map items. A node
succeeds only when every child succeeds; otherwise it fails after settling.
Explicit cancellation still cancels unfinished work. The map `mode` option and
mode-specific output types were removed. Successful map output is always
`{ items: { item, index, runId, output }[] }`, in original item order. Expected
business rejections belong in typed task outputs; thrown errors remain runtime
failures. Consumers of `start-only` now wait for child completion, and consumers
of `wait-settled` must stop reading per-item runtime status from successful output.

After retry, refresh the same run and open a new `watch()` iterator: the previous
iterator ended when the run failed. A retry is rejected while a coordinator or
attempt still holds a live lease; allow it to settle before retrying. This avoids
restarting work while its previous handler is still completing. Handlers must
still make external side effects idempotent, as with ordinary crash recovery.

## Schema version 2 migration

Apply this application-owned PostgreSQL migration before deploying this version,
with workflow workers stopped. It preserves the timeout age of existing runs.
New retries reset `active_since`; ordinary progress does not extend the timeout.

```sql
BEGIN;
ALTER TABLE workflow_runs ADD COLUMN active_since timestamptz;
UPDATE workflow_runs SET active_since = created_at;
ALTER TABLE workflow_runs
  ALTER COLUMN active_since SET NOT NULL,
  ALTER COLUMN active_since SET DEFAULT now();
UPDATE workflow_schema_version SET version = 2 WHERE id = 1;
COMMIT;
```

Attempt errors remain in immutable attempt history. Run/node callback errors are
current-state fields and are cleared by retry; durable callback-error history and
workflow-definition version pinning are outside this change.

## Schema version 3 migration

Apply after the version 2 migration, with workflow workers stopped. Existing
attempts retain their prior retry accounting; the next manual retry starts a
fresh budget while absolute attempt numbers and history remain unchanged.

```sql
BEGIN;
ALTER TABLE workflow_attempts ADD COLUMN retry_attempt_number integer;
UPDATE workflow_attempts SET retry_attempt_number = attempt_number;
ALTER TABLE workflow_attempts ALTER COLUMN retry_attempt_number SET NOT NULL;
UPDATE workflow_schema_version SET version = 3 WHERE id = 1;
COMMIT;
```
