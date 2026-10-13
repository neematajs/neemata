# Native Effect workflows (experimental)

`@nmtjs/workflows/native-effect` runs Neemata workflows on Effect's own durable
workflow engine. Effect owns execution: checkpoints, replay, suspension,
signals, timers, child executions and recovery. Neemata adds definitions with
pool placement, checkpoint helpers, a small client, a SQL composition and Neem
hosting.

It runs **beside** the existing engine. Nothing in `@nmtjs/workflows`,
`@nmtjs/workflows/effect` or their tables is changed, replaced or migrated, and
the two engines share no state. This is not the existing `./effect` entry
point, which adapts Effect handlers onto Neemata's own engine.

| Entry point                              | Contents                                              |
| ---------------------------------------- | ----------------------------------------------------- |
| `@nmtjs/workflows/native-effect`         | definitions, `step`, `call`, `forEach`, waits, client |
| `@nmtjs/workflows/native-effect/sql`     | persistent engine over SQL                            |
| `@nmtjs/workflows/native-effect/neem`    | Neem planner and worker                               |
| `@nmtjs/workflows/native-effect/inspect` | read-only journal of one execution (PostgreSQL)       |

## Status and versions

- This entry point is experimental and has not been run in production. It is
  missing features a production deployment would rely on; see
  [Differences from the existing engine](#differences-from-the-existing-engine)
  and [Validation](#validation).
- The Effect modules used here (`effect/workflow`, `effect/cluster`) are marked
  unstable upstream, and the persistent engine changed materially between
  4.0.0 and 4.0.3 (shutdown handoff, durable races, migrations). Patch
  releases break it too: 4.0.4 turned `WorkflowInstance.awaitedDeferreds`,
  which `awaitWithin` writes to, from a `Set` into a `Map`.
- **Verified target: exactly Effect 4.0.4.** Pin `effect`,
  `@effect/platform-node` and `@effect/sql-pg` to `4.0.4`, without a range.
  Earlier versions no longer work, for the reason above. Later versions are
  untested, not assumed compatible: run the suites under
  [Validation](#validation) before moving the pin.
- The package's `effect` peer range is `^4.0.4`, shared with the existing
  engine. Its upper end says nothing about this entry point.
- This repository pins and locks all three packages at exactly 4.0.4, so its
  own checks run against the target. Earlier revisions were also checked
  against 4.0.0 and 4.0.3, the versions locked then; that is history, not
  further targets.
- Stored names are data. A workflow name, step name, signal name or payload
  schema that changes while executions are outstanding breaks their replay.
  There is no workflow versioning.

## A workflow and a task

```ts
import {
  awaitWithin,
  call,
  defineTask,
  defineWorkflow,
  step,
} from '@nmtjs/workflows/native-effect'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { DurableDeferred } from 'effect/workflow'

// Your own code: any Effect that fails with `Declined`.
declare const charge: (invoice: string) => Effect.Effect<void, Declined>

class Declined extends Schema.TaggedError<Declined>()('Declined', {
  reason: Schema.String,
}) {}

export const Approval = DurableDeferred.make('approval', {
  success: Schema.Boolean,
})

// A task is a workflow of its own, placed in another pool.
export const RenderReceipt = defineTask('receipt.render', {
  payload: { invoice: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ invoice }) => invoice,
  pool: 'render',
})

export const Invoice = defineWorkflow('invoice', {
  payload: { invoice: Schema.String },
  success: Schema.String,
  error: Declined,
  idempotencyKey: ({ invoice }) => invoice,
})

export const RenderReceiptLive = RenderReceipt.toLayer(({ invoice }) =>
  step({
    name: 'render',
    success: Schema.String,
    execute: Effect.succeed(`receipt://${invoice}`),
  }),
)

export const InvoiceLive = Invoice.toLayer(({ invoice }) =>
  Effect.gen(function* () {
    // Wait up to a day for a human; the workflow holds no thread meanwhile.
    const approved = yield* awaitWithin('approval', Approval, '1 day')
    if (Option.isNone(approved) || !approved.value) {
      return yield* new Declined({ reason: 'not approved' })
    }

    yield* step({
      name: 'charge',
      error: Declined,
      retry: { times: 3, backoff: (attempt) => `${attempt * 2} seconds` },
      execute: charge(invoice),
    })

    return yield* call('receipt', RenderReceipt, { invoice })
  }),
)
```

A definition is a native `Workflow`: `Invoice.execute`, `.poll`, `.interrupt`,
`.resume`, `.toLayer` and `Workflow.withCompensation` are Effect's own.
Everything in `effect/workflow` can be used directly in a handler.

### How a handler runs

A handler is an ordinary Effect program that the engine **replays**. Each time
the workflow resumes, the handler runs again from the top; `step`, `call`,
signals and timers return their stored results instead of doing the work
again. Local variables, plain reads, `Date.now()` and randomness outside a
step are recomputed on every replay, so anything that must not change belongs
in a step.

Suspension is not failure: a workflow waiting for a signal, timer, child or
parked step has a `Suspended` result and occupies no fiber.

## Steps

`step` is a named checkpoint over `Activity.make`.

- **Identity.** A checkpoint is keyed by execution and name. Using one name
  twice in a pass over the body would silently hand the second use the first
  one's result, so `step` and `call` fail the workflow with a `DuplicateName`
  defect instead. Give loop and map items their own names (`forEach` does).
- **No nesting.** A step's body is plain work. A `step` or `call` made inside
  it fails the workflow with a `NestedCheckpoint` defect, because the name
  guard cannot cover it: the engine skips a finished step's body on replay, so
  a name used there would be seen in one pass and missing from the next, and
  a later checkpoint of the same name would silently take its result. Make
  steps and calls in the workflow body, or in a child workflow. Functions that
  a body is split into are not nested, and neither is a workflow that a step
  starts with `start`.
- **Retry.** `retry: { times, while, backoff }` retries typed failures only;
  defects and interruption are never retried. Each attempt is its own
  checkpoint, so a replay continues from the attempt it had reached. `backoff`
  is a timer the engine schedules, however short, so it is not restarted when
  a runner is replaced; on SQL it is therefore no finer than the poll
  interval. It must be deterministic: no jitter, because a replay recomputes
  it. The workflow reads as `Suspended` while it backs off.
- **Park.** With `park: true`, a step that has no attempts left suspends the
  workflow instead of failing it. `retryStep(definition, executionId, name)`
  grants a new budget and wakes it; completed steps keep their results. A
  parked step parks the whole execution, including a `forEach` it is part of,
  and reads as `Suspended` like any other wait.
- **At-least-once.** A step interrupted before its result is stored runs again
  under the next owner. Pass `Activity.idempotencyKey(name)` to services that
  can deduplicate. Nothing here makes an external side effect exactly-once.

Manual retry is deliberately a signal and not `Workflow.resume`: `resume` only
restarts a suspended run, and a failed attempt's stored result would be
replayed as the same failure.

## Tasks and child workflows

`call(name, definition, payload)` runs a task or workflow as a native child
execution and waits for it.

- A child has its own execution id, its own stored result, and can be polled
  or interrupted on its own. Interrupting the parent interrupts children that
  have not finished.
- Its identity is the parent execution plus `name`. The same payload called
  from two steps or two parents runs twice; a replay of the parent rejoins the
  child it started. Started directly through `start` or `execute`, a
  definition is identified by its `idempotencyKey` alone.
- The caller's identity travels in a reserved optional payload field
  (`callField`). Handlers can ignore it; `describe` omits it.

`forEach(name, items, { key, concurrency }, body)` runs the body per item
under the name `${name}/${key}` and **settles all items**, returning one `Exit`
per item in order. A failed item does not stop its siblings, as with the
existing engine's map and parallel nodes; unlike there, the caller decides
what a failure means. While any item still waits, the whole workflow is
suspended and no `Exit` is returned. An item's failure is settled without the
interruptions in its cause; a cause that holds nothing but interruptions is
the engine suspending or stopping the run and is never an item's result.

## Signals and timers

- A signal is a `DurableDeferred`, completed from outside with `signal`. A
  signal sent before the workflow awaits it is stored and read later. Prefer
  `signal` to calling `DurableDeferred.done` yourself: it first makes the
  definition known to the engine, which otherwise routes a completion for a
  definition it has not seen to the default pool. The engine's tokens are
  routing handles, not credentials: authenticate callers yourself.
- The `Exit` passed to `signal` is the answer the workflow receives: a value,
  a typed failure or a defect. Interruption is not an answer. The engine
  suspends and preempts a run by interrupting it, so an interruption read
  from a signal would stop the run instead of informing it. `signal`
  therefore fails with `SignalInterrupted`, storing nothing, when the `Exit`
  holds only an interruption. It does not cancel the workflow; `interrupt`
  does.
- Complete signals through `signal`. `DurableDeferred.done` and `failCause`
  are Effect's own and make no such check. `awaitWithin` still reads a signal
  completed that way safely, as described below. A plain
  `DurableDeferred.await` does not: it hands a stored interruption to the
  engine as an interruption of the run, and no result is ever stored. The SQL
  engine then replays the run in a tight loop, and on the memory engine
  `status` fails with the interruption as a defect.
- `sleep(name, duration)` is a timer the engine schedules, so it outlives the
  runner that set it. Timers fire when their runner next polls, not at an
  exact instant.
- `awaitWithin(name, signal, timeout)` waits for the signal or the deadline,
  whichever a runner sees finish first, and records that outcome under `name`.
  Every later replay takes the recorded branch:
  - the signal succeeded: `Option.some(value)`;
  - the signal failed: `awaitWithin` fails with the signal's own typed
    failure. It is an ordinary failure, not an interruption, so `catchTag`
    handles it and inside `forEach` it settles as that item's `Exit`. The
    deadline passing afterwards does not turn it into `None`. Interruptions
    stored beside the failure are dropped;
  - the signal holds only an interruption, which `signal` never stores:
    `awaitWithin` dies with a `SignalInterrupted` defect as soon as it reads
    it, and the workflow fails unless the defect is handled;
  - the deadline passed: `Option.none()`. A signal that succeeds or fails
    afterwards does not change this wait. It stays stored, so awaiting the
    same signal again later in the body reads it. If it arrives while the
    run that saw the deadline pass is still going, that run is preempted and
    replays once from its checkpoints.

  A deadline takes effect when a runner evaluates it, not at the instant it
  passes: timers fire on a poll, and not at all while no runner serves the
  pool. The engine stores no order between a signal and a timer, so an
  outcome the signal already has when the deadline is evaluated wins. The
  losing timer still fires later and causes at most one extra, fully cached
  replay.

## Client

```ts
import { signal, start, status } from '@nmtjs/workflows/native-effect'

const id = yield * start(Invoice, { invoice: '254' }) // does not wait
const current = yield * status(Invoice, id) // Pending | Suspended | Succeeded | Failed | Interrupted
yield * signal(Invoice, id, Approval, Exit.succeed(true))
yield * Invoice.interrupt(id)
```

- `status` maps the engine's stored result. `Pending` means no result is
  stored: the id is unknown, or the first run has not reached a checkpoint.
  The engine does not tell those apart.
- `Failed` carries a typed `Cause`. Errors are encoded with the definition's
  `error` schema, so declare the errors callers should see.
- `interrupt` is cooperative: it takes effect when the run next completes a
  step or suspends, runs compensation, and stores an interrupt-only result.
  `interruptUnsafe` exists on the engine and can skip compensation.
- Compensation registered with `Workflow.withCompensation` can run more than
  once, because each replay registers it again. Make it idempotent.

## Engines

### Memory

```ts
import { WorkflowEngine } from 'effect/workflow'

const layer = Layer.mergeAll(InvoiceLive, RenderReceiptLive).pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
)
```

Everything is lost when the process exits, and pools are ignored. Use it for
unit tests and local development.

### SQL

```ts
import { NodeCrypto } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { layerCatalog, layerSql } from '@nmtjs/workflows/native-effect/sql'

const definitions = [Invoice, RenderReceipt]

const runner = Layer.mergeAll(layerCatalog(definitions), InvoiceLive).pipe(
  Layer.provideMerge(
    layerSql({
      pools: ['default', 'render'],
      runner: { host: 'orders-1', slot: 0, pools: ['default'] },
    }),
  ),
  Layer.provide([PgClient.layer({ url }), NodeCrypto.layer]),
)
```

`layerSql` composes `ClusterWorkflowEngine` with `SqlMessageStorage`,
`SqlRunnerStorage` and **no runner-to-runner transport**. Every engine message
is persisted and its owner finds it by polling, so runners need a shared
database and nothing else: no listening ports, no service discovery.

- **Runners.** A runner is one engine instance with an identity (`host`,
  `slot`). Two live runners must never share an identity. A restarted runner
  should keep its identity so it reclaims its own shards immediately.
- **Client only.** Omit `runner` for a process that starts, signals and
  inspects executions but runs none. Such processes draw their request-id
  machine number at random from 1024 values; that is fine for a handful of
  them, and something to design before running hundreds.
- **Catalog.** Every runner must list every definition of the deployment
  through `layerCatalog`, including those it does not execute. A finished
  task wakes its parent, and the engine needs the parent's definition to find
  it; without it the wake fails. The catalog requires the services that the
  listed definitions' `success` and `error` schemas decode with, so a runner
  provides them for every definition, not only for the ones it executes.
- **Schema services.** A `step` requires the services its `success` and
  `error` schemas encode and decode with, since it stores its result and reads
  it back. Provide them to the handler layer.
- **Latency.** Work for another runner starts within `pollInterval` (500 ms by
  default); replies are polled every 200 ms. This trades latency for having
  no network between runners.
- **Tables.** `prefix` (default `nmtjs_native`) names the `<prefix>_messages`,
  `<prefix>_replies`, `<prefix>_runners`, `<prefix>_locks` and migration
  tables and the advisory-lock namespace. Use a distinct prefix per
  independent deployment sharing a database.
- **Migrations.** Acquiring the layer creates missing tables, which needs DDL
  permission; on PostgreSQL the layer takes an advisory lock first so runners
  that boot together do not race. This differs from the existing engine, whose
  migrations the application owns. Effect 4.0.3 adds `layerMigrations` and
  `layerStorage` to both storage modules; to migrate with a separate role,
  compose them as `layerSql` does.
- **Connections.** Each runner reserves one connection for shard locks for its
  whole life, and startup briefly reserves a second for the migration lock. Give a runner's pool at
  least three connections, plus what your own transactions hold. PostgreSQL
  shard locks are session advisory locks, so the pool must not multiplex
  sessions (no transaction-mode PgBouncer).
- **Dialects.** Only PostgreSQL has been run. Effect's storage modules also
  target MySQL, MSSQL and SQLite.

A standalone process owns its own lifetime with `NodeRuntime.runMain`:

```ts
NodeRuntime.runMain(Layer.launch(runner))
```

`tests/fixtures/native-effect/runner.ts` is a complete runnable example.

## Pools and placement

A pool is a `ClusterSchema.ShardGroup`. Each pool has a fixed set of shards;
executions hash onto shards; live runners that serve the pool divide the
shards between them by `weight`.

This is **not** the existing engine's pool:

|               | Existing pools                      | Native pools                                        |
| ------------- | ----------------------------------- | --------------------------------------------------- |
| Assignment    | any idle worker claims the next job | an execution belongs to the runner owning its shard |
| Idle capacity | picks up queued work at once        | does not take work from a busy runner's shards      |
| `concurrency` | job slots per worker                | none: every execution a runner owns may run         |
| `weight`      | —                                   | share of shards, not a concurrency limit            |
| Activities    | run in the workflow's pool          | run in the workflow's runner                        |

A runner with a slow execution does not block others it owns (each runs in
its own fiber), but nothing caps how many run at once. Bound resource use
inside handlers, for example with a semaphore in a layer.

All runners must agree on the full `pools` list and on `shardsPerGroup`: both
are part of how shard locks are numbered, and runners that disagree can each
believe they own the same shard. Change them only with every runner stopped.

A pool nobody serves keeps its executions queued. A runner that owns a shard
but has no handler for a definition placed there fails the execution after
the engine's registration timeout.

## Neem

```ts
// native.runtime.ts
export default createNativeWorkflowsRuntime({
  name: 'workflows',
  planner: './native.planner.ts',
  worker: { entry: './native.worker.ts' },
})

// native.planner.ts
export default defineNativeWorkflowsPlanner(() => ({
  pools: { default: { threads: 2 }, render: { threads: 1 } },
}))

// native.worker.ts
export default defineNativeWorkflowsWorker({
  definitions: [Invoice, RenderReceipt],
  handlers: (pool) => (pool === 'render' ? RenderReceiptLive : InvoiceLive),
  layer: () => Layer.mergeAll(PgClient.layer({ url }), NodeCrypto.layer),
})
```

`layer` also provides whatever the handlers and the definitions' result
schemas require; a missing service is a type error on the worker definition.

Each planned thread is one runner serving one pool. There is no coordinator
role. Neem keeps build, readiness, reload, health and lifecycle: the worker is
built on `@nmtjs/effect`'s `defineEffectWorker`, so stopping a thread
interrupts the engine and releases `layer` afterwards, and no signal handlers
are installed inside threads. A thread is ready once its engine layer is built
(tables present, runner registered).

The runner identity is the machine's hostname plus the thread's planned
position. Two Neem processes on one machine sharing a database and prefix must
set `engine.host` to different values.

### Shutdown budget

Neem stops a runtime within 15 seconds by default. A stopping runner gives
executions `terminationTimeout` (5 seconds here, 15 in Effect's defaults) to
reach a checkpoint, then abandons them to the next owner without storing a
failure. Lock release and `layer` teardown come out of the same 15 seconds, so
keep `terminationTimeout` well below Neem's stop timeout and keep finalizers
bounded. If the budget is exceeded Neem kills the thread; that is safe for the
engine, which treats it like a crash.

After a crash, a runner's shards are reassigned when its heartbeat expires:
about 15 seconds with these defaults (`shardLockExpiration`), 35 with Effect's.

The engine's background loops retry storage errors internally. They are not
linked to the worker's main fiber, so a runner that has permanently lost its
database keeps its thread alive without making progress; monitor it through
`ClusterMetrics` or your database.

## Starting a workflow in your own transaction

```ts
yield *
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO orders ${sql.insert(order)}`
      yield* start(Invoice, { invoice: order.id })
    }),
  )
```

When the transaction uses the same `SqlClient` that backs `layerSql`, the
start is written in that transaction: it becomes visible on commit and never
runs after a rollback. Conditions:

- use `start` (or `execute` with `discard: true`); waiting for the result
  inside the transaction would wait for a row nobody else can see;
- the execution begins on the owner's next poll after commit, not at commit;
- only the start is atomic. What handlers do later is outside the transaction.

## Inspection

- `describe(definition)` returns the static shape: name, kind, pool and JSON
  schemas. A native workflow is a program, not a graph, so there is no graph
  snapshot to serialize.
- `status` reads the stored result of one execution.
- `inspect(definition, executionId, { prefix })` lists what the engine has
  stored for one execution: its run, every activity attempt with its outcome,
  completed signals, timers and child wake-ups, in order. The decision of an
  `awaitWithin` is listed as a signal named `raceAll/<name>`; it reads
  `succeeded` once a decision is stored, including the decision that the
  awaited signal failed.

`inspect` is a read model: it reads the engine's own tables and decides
nothing. It depends on Effect's internal table layout, which is not a public
contract and has already changed between patch releases; it is PostgreSQL
only and should be re-verified on every Effect upgrade. It cannot show a wait
that nobody has completed yet, and a child's steps are listed under the
child's execution id. There is no listing or searching of executions.

## Differences from the existing engine

| Concern                           | Existing engine                        | Native Effect                               |
| --------------------------------- | -------------------------------------- | ------------------------------------------- |
| Authoring                         | declared graph of nodes                | replayed Effect program                     |
| Signals, in-workflow timers       | none                                   | native                                      |
| Tasks                             | own run, claimed by a pool             | child workflow in a shard group             |
| Map / parallel                    | settle all, then fail                  | `forEach` settles all, returns Exits        |
| Retry                             | per-node policy with backoff           | `step` retry with durable backoff           |
| Manual retry                      | reopens a failed run                   | `park` + `retryStep`; a failed run is final |
| Restart                           | new root run                           | start with a different key                  |
| Idempotency vs uniqueness         | separate; active/all, reject/join      | one key; same key always joins              |
| Timeouts                          | node, task, workflow                   | none built in; race a timer                 |
| Errors                            | stored error records                   | typed `Exit` encoded by schema              |
| Cancel                            | immediate, with reason                 | cooperative `interrupt`                     |
| Atomic start                      | adapter `atomicStart`                  | ambient `SqlClient` transaction             |
| History                           | runs, nodes, attempts, graph snapshots | `inspect` journal; no graph                 |
| Listing, watch, tags              | yes                                    | no                                          |
| Schedules                         | PostgreSQL scheduler                   | none (`ClusterCron` is not wired)           |
| Retention, pruning, dead commands | yes                                    | none; tables grow                           |
| Stale-write fencing               | PostgreSQL lease fences                | shard locks only                            |
| Redis / Valkey                    | supported                              | not supported                               |
| Promise handlers, Standard Schema | supported                              | Effect and Effect Schema only               |
| Migrations                        | application-owned                      | run when the layer is acquired              |

Not implemented, and not planned as shims: compatibility with the existing
contract DSL, migration of existing runs, a graph compiler, a Promise client
(use `ManagedRuntime.runPromise`), `WorkflowProxy` HTTP/RPC exposure, and
`DurableQueue`-based tasks.

## Validation

Tests live in `tests/native-effect-memory.spec.ts`,
`tests/native-effect-types.spec.ts`,
`tests/integration/native-effect-sql.spec.ts` and
`tests/integration/native-effect-neem.spec.ts`. The integration specs need
`POSTGRES_URL` (PostgreSQL 17 was used) and skip without it.

| Suite                  | Effect 4.0.4 (this repository) | Effect 4.0.3 (earlier revision) | Effect 4.0.0 (earlier revision) |
| ---------------------- | ------------------------------ | ------------------------------- | ------------------------------- |
| Type check             | yes                            | yes                             | yes                             |
| Memory engine          | yes                            | yes                             | yes                             |
| PostgreSQL engine      | yes                            | yes                             | yes                             |
| Neem-hosted end to end | yes                            | yes                             | yes                             |

The 4.0.4 column is the current run in this repository, whose lockfile
resolves `effect`, `@effect/platform-node` and `@effect/sql-pg` to exactly
4.0.4. It passed 28 memory tests, 4 type-contract tests and 12 integration
tests (11 PostgreSQL scenarios and 1 Neem-hosted scenario), with integration
retries disabled. Type checks and scoped lint and formatting pass.

The 4.0.3 and 4.0.0 columns are historical: earlier revisions of these
sources passed the suites while the repository locked those versions. The
current sources are not run against them and do not type-check there.

Covered: replay around a signal, per-parent child identity, the duplicate
name guard (including race arms), rejection of a step or call inside a step,
settle-all fan-out, a fan-out suspended by a wait on another fiber of an item,
retry with backoff, budget exhaustion, park and `retryStep`, deadlines, a
failed signal before and after a deadline (replayed on another runner), a
stored failed signal with a zero timeout, a signal stored with an interruption
beside its failure or with nothing else, `signal` refusing the latter, schema
services for step results and catalogued definitions, interruption with
compensation, layer lifetimes, placement across two runners, a signal from a
fresh client to a non-default pool, atomic start with commit and rollback, a
timer surviving its runner, graceful handoff, recovery after `SIGKILL`, the
`inspect` journal, and a Neem-hosted run with a clean stop.

Not covered: MySQL, MSSQL and SQLite; multi-host deployments; load, latency
and failover-time measurements; database outages; a crash during a backoff;
development reload under Neem; concurrent boot of many processes.
