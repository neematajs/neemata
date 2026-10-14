# Workflows

Use `@nmtjs/workflows` for durable orchestration on Effect 4: every run is
stored, every step runs as an attempt with retries and timeouts, and a run
continues from what is stored after a crash or deploy. Handlers run at least
once; make external side effects idempotent with `attempt.idempotencyKey`.
PostgreSQL suits transactional starts, SQL inspection and long retention;
Redis/Valkey suits high throughput with history pruned by retention. Use the
in-memory store for tests.

The package README is the full guide; its examples run in
`packages/workflows/tests/readme.spec.ts`.

## Imports

Use package subpaths, not an umbrella `nmtjs` import:

- `@nmtjs/workflows`: `task`, `workflow`, `schedule`, `decodeRun`, the
  `Client`, `Worker` and `InMemory` modules, the `Store` service, tagged
  errors, record types and `InputOf` / `OutputOf` / `Services`.
- `@nmtjs/workflows/postgres`: `layer`, `install`, `verify`, `migrateFrom4`;
  `/postgres/pg` and `/postgres/pglite`: their `notifications` layers;
  `/postgres/drizzle`: `createSchema`. See [PostgreSQL](postgres.md).
- `@nmtjs/workflows/redis`: `layer({ prefix?, maxDeliveries? })`.
- `@nmtjs/workflows/inspector`: browser-safe graph/catalog serialization,
  `nodeUnits`, `parseChildKey`, `isTerminal` and record types.
- `@nmtjs/workflows/neem`: `createWorkflowsRuntime`, `defineWorkflowsPlanner`;
  `@nmtjs/workflows/neem/worker`: `defineWorkflowsWorker`.

Peers: `effect@^4.0.4`; `@effect/sql-pg` or `@effect/sql-pglite` for
PostgreSQL; `drizzle-orm` for `/postgres/drizzle`; `@nmtjs/effect` for
`/neem/worker`. Redis needs a driver that provides Effect's `Redis` service,
such as `NodeRedis.layer` from `@effect/platform-node`.

## Schemas and handlers

Schemas are `effect/Schema`, decoding synchronously without services.
Handlers, clients and computed values see the schema's `Type`; the store holds
its encoded form, which must be JSON (`Schema.NumberFromString` is a number in
code, text in the store). The engine fails the attempt, or refuses the start,
when an encoded value is not JSON.

A task or activity handler is `(input, attempt) => Effect<Output, unknown, R>`:

- `R` is the services it yields; the execution worker that runs it must
  provide them, and `Worker.execution`'s type requires it. Each attempt gets
  its own `Scope`, so `Effect.acquireRelease` works directly.
- A failure or defect fails the attempt, which is retried under its policy.
- Interruption tells a handler to stop: cancellation, attempt timeout,
  shutdown or a lost claim. There is no signal argument; use
  `Effect.tryPromise` with its `AbortSignal` for Promise APIs. A handler
  cannot tell why it was interrupted.
- `attempt` carries `runId`, `nodeName`, `childKey`, `attemptNumber` (from 1,
  across retries) and `idempotencyKey`: one opaque string for every attempt
  of this work, manual retries included.

## Tasks

```ts
import { task } from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export const Decorate = task({
  name: 'content.decorate',
  pool: 'content',
  input: Schema.String,
  output: Schema.String,
  retry: { attempts: 3, backoff: 'exponential', delay: '1s' },
  timeout: '30s',
  handler: (text) => Effect.succeed(`Prepared: ${text}`),
})
```

Options: `name`, `pool` (required, no default pool), `input`, `output`,
`handler`, `retry`, `timeout` (one attempt; units `ms`, `s`, `m`, `h`, `d`),
`revision`, `tags: (input) => Record<string, string>`,
`idempotency: (input) => unknown[]`, `unique` (a key function or
`{ key, scope?, behavior? }`), `title`, `description`. `retry.attempts`
counts every attempt, the first included; without `retry` the work runs once.

## Workflows

`workflow(options, body)` takes the task options except `handler` and `retry`;
its `timeout` limits the whole run (`RunTimeout`), counted from creation or
the last manual retry and enforced by a coordinator sweep. The body is a
generator run once, at declaration: each `w.*` call describes a step, and
`yield*` places it and returns a `Ref` to its output. The body returns the
result, computed from references.

```ts
import { workflow } from '@nmtjs/workflows'

export const Prepare = workflow(
  {
    name: 'content.prepare',
    pool: 'content',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
  },
  function* (w) {
    const clean = yield* w.activity('clean', {
      input: Schema.String,
      output: Schema.String,
      from: Effect.map(w.input, ({ text }) => text),
      handler: (text) => Effect.succeed(text.trim()),
    })
    const decorated = yield* w.task('decorate', Decorate, { input: clean })
    return Effect.map(decorated, (text) => ({ text }))
  },
)
```

Steps (`w` in the body, `p` in `cases` / `members`):

| Call                                  | Options                                                                    | Reference holds                               |
| ------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| `w.activity(name, opts)`              | `input`, `output` (schemas), `from`, `handler`, `retry?`, `timeout?`       | the output                                    |
| `w.task(name, Task, opts)`            | `input`, `retry?`, `timeout?`                                              | the task's output                             |
| `w.workflow(name, Workflow, opts)`    | `input`, `cancellation?`                                                   | the child's output                            |
| `w.branch(name, opts)`                | `select`, `cases: (p) => ({ key: case })`                                  | the union of case outputs                     |
| `w.parallel(name, opts)`              | `members: (p) => ({ key: member })`                                        | `{ [key]: member output }`                    |
| `w.mapTask(name, Task, opts)`         | `item` (schema), `items`, `input: (item, index) => Effect`, `concurrency?` | `{ items: { item, index, runId, output }[] }` |
| `w.mapWorkflow(name, Workflow, opts)` | the same, with `cancellation?` instead of `retry` / `timeout`              | the same                                      |

`p.activity(opts)`, `p.task(Task, opts)` and `p.workflow(Workflow, opts)` are
the unnamed forms. Every step and case also takes `title` / `description`
(presentation only). `w.input` is the workflow input's `Ref`.

- On a task or workflow step, `input` is the value the target receives; an
  activity names its value `from` because `input` / `output` are its schemas.
  Always pass it: `{ input: w.input }` when the step takes the workflow input.
- Activities run on the execution workers of the workflow's pool. Promote an
  activity to a task when it needs another pool, reuse or its own run.
- `retry` / `timeout` on a task step or `mapTask` replace the task's policy
  whole, per item for a map: N failing items can make N × `attempts` calls.
- Branch: `select` runs once per run and the choice is stored; a case is one
  activity, task or child workflow.
- Parallel and maps wait for every member/item; a failure does not stop
  siblings, and the step fails after all settle. A map's `items` is computed
  once and stored through `item`; `concurrency` must be a positive integer.
  An empty map completes with `{ items: [] }`.
- `cancellation: 'propagate'` (default) cancels the child with its parent;
  `'detach'` lets it run on.
- A multi-step case or member is a child workflow. Branches, parallels and
  maps do not nest; a failed step fails the run; no loops or `if` on run
  values (use `w.branch`); no signals, events or timers inside a run.

References are `Effect<A, never, Run>`. `input`, `from`, `items`, `select`
and the result take Effects over references: `Effect.map(w.input, f)`,
`Effect.all({ ... })`, `Effect.gen`, `Effect.succeed(constant)`. They run in
the coordinator and must be pure and synchronous: the only allowed
requirement is `Run`, the error type is `never`, waiting fails the step, and
they may run more than once. A value reads only the input and earlier steps.
Never branch on a `Ref` in the body: it is always truthy.

Build-time errors throw from `task` / `workflow`: invalid or duplicate node
names (`input`, `__proto__`, `constructor`, `prototype` are reserved), a
missing `yield*`, references of another workflow, a map `concurrency` that is
not a positive integer, a versioned workflow using unversioned targets.

`Prepare.workflows` is the workflow with every child workflow it can start;
`Prepare.tasks` every task they can start. Workers take those lists.

## Client

`Client.*` are Effects requiring `Store`; none retries, and any may fail with
`StorageError`.

```ts
import { Client, decodeRun, InMemory } from '@nmtjs/workflows'
import * as Stream from 'effect/Stream'

// Nothing completes until workers serve the store; see Workers.
const program = Effect.gen(function* () {
  const run = yield* Client.start(
    Prepare,
    { text: ' hello ' },
    { tags: { documentId: 'd1' }, idempotencyKey: ['prepare', 'd1'] },
  )
  yield* Stream.runDrain(Client.watch(run.id))
  const records = yield* Client.get(run.id)
  return decodeRun(Prepare, records!.run).output
}).pipe(Effect.provide(InMemory.layer()))
```

Start options replace what the declaration's builders give: `tags`,
`idempotencyKey`, `unique: { key, scope?, behavior? }`, and `startAt` (Unix
ms; the run exists at once and is worked from then). `start` answers with the
decoded run, written in one commit with its command and saved definition.

- Idempotency key: the same kind, name, revision and input answer with the
  holder; anything else fails with `IdempotencyConflict` (`runId`). Held for
  as long as the run exists.
- Unique key: `scope: 'active'` (default) holds it until the run ends,
  `'all'` while the run exists; `behavior: 'reject'` (default) fails with
  `RunConflict` (`runId`, `status`), `'join'` answers with the holder.
- `DefinitionConflict` when the declaration differs from what is saved for
  its revision. A non-encodable input or throwing builder is a defect.
- Errors are tagged; handle them with `Effect.catchTag('RunConflict', ...)`.

Other calls:

- `cancel(runId)`: the run or `undefined`. A task run is cancelled at once; a
  workflow run becomes `cancelling` until its next coordination pass cancels
  what is in flight (detached children excepted). Handlers are interrupted.
- `retry(runId, { expectedVersion? })`: reopens a failed root in place,
  rerunning only what failed with a fresh retry budget; keeps id, input, tags
  and keys. Fails with `RunNotFound`, `RunNotRoot`, `RunNotFailed`,
  `StaleRunVersion`, `RunConflict` or `RunBusy` (family still in flight).
- `restart(runId, { definitions, ...startOptions })`: a new root from the
  stored input, resolved to the declaration with the same kind, name and
  revision. The declaration's `idempotency` builder still applies: pass a
  fresh `idempotencyKey` for a genuinely new run. Adds `RunNotTerminal` and
  `UnknownDefinition`.
- Reads: `get` (`{ run, nodes, children, attempts }` with payloads),
  `getDetail` (payload-free, with `childRuns`), `getNode`, `getFamily`,
  `list` / `listSummaries` (`{ runs, nextCursor? }`, newest first),
  `inspect` (`{ detail, definition }`), `getDefinition({ kind, name,
revision })`. Filters: `kind`, `name`, `revision` (`null` = unversioned),
  `status`, `parentRunId` (`null` = roots), `rootRunId`, `tags`, `input`
  (JSON containment), `createdBefore`, `activeBefore`, `limit` (100),
  `cursor`. Records are stored JSON with Unix-ms times; `decodeRun(decl, run)`
  types one.
- `watch(runId, { pollIntervalMs?, wake?, debounceMs? })`: a `Stream` of
  `{ kind: 'run', status, error? }` ending with the final status; `wake`
  adds coarse, best-effort `{ kind: 'change' }` hints. A retried run needs a
  new watch.
- `listDeadCommands({ runId?, limit?, cursor? })` and
  `requeueDeadCommand(id)` (answers `boolean`). A command is dead after the
  store's `maxDeliveries` (20); the coordinator's reaper then fails its work.
- `deleteRun(runId)` (`{ deleted }`; `RunBusy` while in flight) and
  `pruneRuns({ olderThan, statuses?, batchSize? })` (`{ deleted }`) delete
  ended root families. Saved definitions are never deleted.
- `schedules.list()`, `schedules.trigger(name)`,
  `schedules.setEnabled(name, on)`; the last two fail with `UnknownSchedule`.

Run statuses: `queued`, `running`, `waiting`, `cancelling`, then
`completed`, `failed` or `cancelled`.

## Workers

Both workers run until interrupted and require `Store`:

```ts
import { Worker } from '@nmtjs/workflows'

const served = { workflows: Prepare.workflows, tasks: Prepare.tasks }
// Throws unless every target and schedule runnable is served, once, and
// every pool a declaration names is listed.
Worker.verify({ ...served, pools: ['content'] })

const workers = Effect.all(
  [
    Worker.coordinator({
      workflows: served.workflows,
      concurrency: 4,
      retention: { olderThan: '30d', statuses: ['completed'] },
    }),
    Worker.execution({ ...served, pool: 'content', concurrency: 8 }),
  ],
  { concurrency: 'unbounded', discard: true },
)
```

- `Worker.coordinator` advances workflow runs (inputs, selectors, results,
  settlement) and owns maintenance: `reaping` (30 s), `runTimeouts` (60 s),
  `schedules` + `scheduling` (1 s), `retention: { olderThan, statuses? }`.
  Each sweep takes `everyMs` / `batchSize`; `false` turns reaping or run
  timeouts off. A deployment needs at least one coordinator.
- `Worker.execution` runs task and activity handlers, of one `pool` or of all
  given; its type requires exactly those handlers' services. Provide them to
  the worker Effect. `cleanupTimeoutMs` (5,000) bounds an interrupted
  handler; an overrun fails the worker with `CleanupTimeout` so the process
  is replaced.
- Both take `concurrency` (1, per worker, not deployment-wide), `leaseMs`
  (30,000; renewed every third) and `pollMs` (250). Store hints wake idle
  workers early; polling is the guarantee.
- Workers take partial lists, so a missing declaration is silent: queued
  commands wait. Run `Worker.verify` with everything a deployment serves.
- Storage failures of one command or sweep are logged and retried; a worker
  fails with `StorageError` only before it holds anything.

## Schedules

```ts
const Nightly = schedule({
  name: 'content.nightly',
  runnable: Prepare,
  input: { text: 'nightly' },
  cron: '0 2 * * *',
  timeZone: 'Europe/Berlin',
})
```

Exactly one of `cron` or `every` (`'15m'`); optional `timeZone` (stored;
defaults to the process zone), `tags`, `enabled`, `immediately`. Give the
deployment's complete list to `Worker.coordinator({ schedules })`: it
reconciles the stored schedules to that list, **removing any other**, then
fires due slots once across coordinators. Missed slots are skipped. Omitting
`schedules` leaves stored schedules alone. Every store supports schedules.

## Revisions

Without `revision`, a run is identified by name and runs whatever code is
deployed when a command is claimed. A `revision` (an opaque non-empty string)
pins a run, and everything it starts, to that code: work is routed by kind,
name and revision, and unversioned code never runs versioned runs or the
reverse. A versioned workflow may use only versioned targets.

- Starting a run saves its graph (`graphHash`, SHA-256 of step names, kinds
  and order) and, for versioned runs, a manifest of target revisions.
  Changing the graph or a target revision under a saved revision fails with
  `DefinitionConflict`; handler, schema and policy changes are not detected.
- A revision no worker serves leaves its commands queued untouched and its
  runs untimed until it is served again. Runs never move revision.
- Deploy a new revision by serving both, waiting until
  `Client.list({ name, revision: old, status: [active statuses] })` is empty,
  then removing the old code. Idempotency replays and `join` match only the
  same revision.

## Stores and inspector

A store is a `Layer` providing `Store`; clients and workers of a deployment
share one. `InMemory.layer({ maxDeliveries? })` is per build and not durable.
PostgreSQL: see [PostgreSQL](postgres.md).

```ts
import { NodeRedis } from '@effect/platform-node'
import * as Redis from '@nmtjs/workflows/redis'

const store = Redis.layer({ prefix: 'content:', maxDeliveries: 20 }).pipe(
  Layer.provide(NodeRedis.layer({ url })),
)
```

Redis/Valkey: the default prefix is `nmtjs:workflows:`; isolate deployments
by prefix. Run `maxmemory-policy noeviction`; durability is the server's
persistence and replication. No key expires: prune with coordinator
`retention` or `Client.pruneRuns`. Every key shares one hash tag, so a
cluster keeps the store in one slot. A failure during a script leaves its
outcome unknown: retry the high-level operation with the same identity.

`@nmtjs/workflows/inspector` imports no Node API. Serve
`serializeWorkflowGraph(declaration)` / `serializeWorkflowCatalog({
workflows, tasks })` for the deployed definitions and `Client.inspect(runId)`
for a run's saved graph; in the browser, `renderWorkflowGraph(structure,
presentation)` and `nodeUnits(detail, nodeName)` join a step's children,
attempts and child runs. Child keys are `$self`, `case:<key>`,
`member:<key>` and `item:<index>`. When `definition.source` is `'observed'`,
no trustworthy graph exists for the run; do not fill one in from current code.

## Neem integration

Use three modules: a runtime declaration, a planner (main thread, no
application imports) and a worker loaded in every thread.

```ts
// workflows.runtime.ts
import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

export default createWorkflowsRuntime({
  name: 'workflows',
  planner: './workflows.planner.ts',
  worker: { entry: './workflows.worker.ts' },
})
```

```ts
// workflows.planner.ts
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1, concurrency: 4 },
  pools: { content: { threads: 2, concurrency: 8 } },
}))
```

```ts
// workflows.worker.ts
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem/worker'
import * as Postgres from '@nmtjs/workflows/postgres'

export default defineWorkflowsWorker({
  workflows: Prepare.workflows,
  tasks: Prepare.tasks,
  schedules: [Nightly],
  store: () => Postgres.layer().pipe(Layer.provide(database)),
  layer: (ctx) => Layer.succeed(Formatter, formatter(ctx.logger)),
})
```

- The plan's `coordinator` and each pool take `threads` (1) plus the worker
  options above (`concurrency`, `leaseMs`, `pollMs`; `cleanupTimeoutMs` for
  pools; maintenance options for the coordinator). At least one pool is
  required, and every pool a declaration names must be planned. Schedules
  belong to the worker, not the plan.
- `store(ctx)` and `layer(ctx)` are called each time a thread starts,
  including dev reloads. Threads share runs only through a durable store;
  `InMemory.layer()` would give each thread its own.
- `layer` must provide every handler service of the whole definition (the
  type requires it; optional when there are none). It may use the store and
  is built only in execution threads.
- A thread starts only if `Worker.verify` accepts what is served, scheduled
  and planned. `Effect.log*` goes to `ctx.logger`.
- Stopping interrupts handlers, gives their commands back, then releases the
  handler services and the store, within Neem's stop deadline. A
  `CleanupTimeout` fails the thread without releasing services still in use.

## Upgrading from the Promise engine

`@nmtjs/workflows` up to `0.18.0-alpha.4` was a Promise engine
(`defineTask` / `implementTask`, `createWorkflowRuntimeClient`,
`/effect`, `/runtime`, Standard Schema, `lifecycle.signal`). Its code does not
carry over: follow the README's "Upgrading from the Promise engine" tables.
Runs in flight are never converted: drain and stop the old engine first.
PostgreSQL then migrates schema generation 4, which `0.18.0-alpha.4`
installs, to 6 (`Postgres.migrateFrom4` or `MIGRATION_FROM_4_SQL`, which
refuse while runs or commands are in flight; old runs stay unversioned);
Redis starts empty.
