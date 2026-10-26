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

- `@nmtjs/workflows`: `task`, `workflow`, `durable`, `schedule`, `decodeRun`, the
  `Client`, `Worker` and `InMemory` modules, the `Store` and
  `Instrumentation` services, tagged errors, record types (`Headers`,
  `AttemptInfo`, `AttemptResult`, `StartRequest`) and `InputOf` /
  `OutputOf` / `Services`.
- `@nmtjs/workflows/postgres`: `layer`, `install`, `verify`, `migrateFrom4`;
  `/postgres/pg` and `/postgres/pglite`: their `notifications` layers;
  `/postgres/drizzle`: `createSchema`. See [PostgreSQL](postgres.md).
- `@nmtjs/workflows/redis`: `layer({ prefix?, maxDeliveries? })`.
- `@nmtjs/workflows/inspector`: browser-safe graph/catalog serialization,
  `nodeUnits`, `durableView`, `parseChildKey`, `isTerminal` and record
  types.
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
  `Effect.tryPromise` with its `AbortSignal` for Promise APIs.
  `attempt.stopReason` (`cancelled`, `timedOut`, `shutdown`, `claimLost`) is
  set before the interruption, so finalizers can read why.
- `attempt` carries `runId`, `nodeName`, `childKey`, `attemptNumber` (from 1,
  across retries) and `idempotencyKey`: one opaque string for every attempt
  of this work, manual retries included. Also `kind` (`task` / `activity`),
  `name`, `revision`, `attemptId`, `deliveries`, the run's `headers`, and
  `createdAt` / `availableAt` / `claimedAt` by the store's clock (claimed
  less available is the wait for a worker).

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

## Durable workflows

`durable(options, body)` declares a workflow whose steps are decided as a run
goes. The body is ordinary Effect code, with loops, `if` and `Effect.all` on
real values, that the coordinator **replays from the start on every pass**
against the run's stored operations. Use it when what happens next depends on
earlier results; use `workflow` for a fixed graph or a map of thousands.

```ts
import { durable } from '@nmtjs/workflows'

export const Document = durable(
  {
    name: 'docs.document',
    revision: 'v1', // required
    pool: 'docs',
    input: Schema.Struct({ sections: Schema.Array(Section) }),
    output: Schema.Array(Schema.String),
    tasks: [DraftSection], // everything the body may start, each versioned
  },
  ({ sections }, d) =>
    Effect.gen(function* () {
      const drafts: string[] = []
      for (const section of sections) {
        const draft = yield* d.task(
          `draft:${section.id}`,
          DraftSection,
          section,
        )
        drafts.push(draft.text)
        if (!draft.ok) yield* d.sleep(`cool-off:${section.id}`, '1h')
      }
      return drafts
    }),
)
```

| Operation                                                          | Gives                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `d.task(name, Task, input, { retry?, timeout?, onFailure? })`      | the task's output; on failure it blocks the run, or `OperationFailed` |
| `d.workflow(name, Workflow, input, { cancellation?, onFailure? })` | a static or durable child's output                                    |
| `d.sleep(name, '1h')`                                              | `void`, the duration after first reaching it                          |
| `d.now(name)`                                                      | Unix ms when first reached, the same on every replay                  |
| `d.input(family, key)`                                             | the value sent with `Client.send`, however long it takes              |
| `d.input(family, key, { timeout: '7d' })`                          | `{ _tag: 'Received', value }` or `{ _tag: 'TimedOut' }`               |

Options are `workflow`'s plus `revision` (required), `tasks`, `workflows` and
`inputs` (`{ family: Schema }`) and `onFailure` (`'block'` by default): every
target must be versioned and declared
once, at one revision; a family is an identifier (`[a-zA-Z_$][\w$-]*`). Serve
`Document.workflows` / `Document.tasks` as for any workflow.

### Operation names

The app chooses each operation's name, and **the name is its identity**.

- A replay finds a stored operation by name alone: done, it returns the
  stored output at once (the work never runs again); still open, that branch
  suspends; a new name opens a node.
- After the body stops and before anything is written, every operation the
  replay reached is compared with the node under its name: kind, target
  (name and revision) and encoded input. A difference, or a name reached
  twice in one replay, is `ReplayMismatch`: the replay is discarded and the
  run is `blocked` until code that replays it as stored is deployed under
  that revision and the run is resumed. A stored node is never changed to
  fit the code.
- Names are unique within a run (not across runs) and **stable for as long as
  runs of the revision are in flight, across deploys**. Build them from
  stable ids the run already holds, its input or earlier outputs:
  `` `draft:${section.id}` ``. Never from a changing list's index, a
  timestamp, a random value or anything read outside `d.*`. Use a literal for
  a one-off (`'approve'`) and put the round in a repeated one
  (`` `review:${id}:round-${n}` ``, with `n` counted from stored results).
- Names starting with `@` are the engine's (inputs are stored as
  `@family:key`), so `d.task('@x', ...)` throws.
- Only operations the replay reaches are compared: a call the code no longer
  makes leaves its node unused, unnoticed. Renaming, removing or changing an
  operation that runs in flight have stored is a **new revision**, served
  beside the old one until its runs end.

### Replay rules

- The body may require only `Durable` (a handler's service is a type error)
  and must be pure and synchronous: no clock (use `d.now`), no random, no
  I/O; side effects go in tasks. Waiting on anything but `d.*`, a promise or
  `Effect.sleep`, fails the run.
- `Effect.all` / `Effect.forEach` with `concurrency` open several operations
  in one pass. A run whose body ended with abandoned operations still open
  ends once they are stopped.
- An operation whose work failed, retries spent, blocks the run by default;
  with `onFailure: 'fail'` it fails with `OperationFailed` (`operation`,
  `error`), which the body may catch; uncaught, that fails the run. See
  [Blocking and resuming](#blocking-and-resuming).
- Each pass replays everything the run has done: plan for tens or hundreds of
  operations per run, not thousands.
- `Client.retry` refuses a failed durable run (`RunNotRetryable`), since its
  body may have decided from the failure; use `Client.restart`.

### Inputs

A body waits for a value from outside with `d.input(family, key)`; the app
sends it with `Client.send`, by run id or by the unique key the run holds, in
its own transaction when it is in one:

```ts
const decide = (id: string, section: string, approved: boolean) =>
  Client.send(Review, { unique: ['review', id] }, 'verdict', section, {
    approved,
  })
// Receipt: { runId, input: '@verdict:<section>', receivedAt, duplicate }
```

- **Kept until read.** A value sent before the body reaches its input is
  stored and read when it gets there. Open an input together with the work
  that prompts it (`Effect.all`) so the wait exists as soon as anyone can
  answer.
- **First value wins.** The same value again answers with its receipt,
  `duplicate: true`; another fails with `InputRefused` (`reason: 'received'`).
- **A timeout is a deadline** from when the body first reaches the input; a
  value after it is refused (`closed`) even before a pass has noticed.
- **Refused otherwise:** `missing` (no run for the id or key), `other` (a run
  of another workflow, or of a revision not given; `found` names it),
  `ended` (ended or cancelling).
- **A receipt is storage, not processing**: the run reads the value when its
  body reaches the input, if it does.
- **Across revisions** pass every revision the sender may reach:
  `Client.send([ReviewV1, ReviewV2], to, family, key, value)`. The value's
  type is what all of them take; it is encoded in the commit by the run's own
  revision's schema, so schemas must be pure.
- Authorization and validation beyond the schema are the app's, before it
  sends.

### Blocking and resuming

A run that waits days for people should not end because one provider call
failed. Under `onFailure: 'block'` (the default; per operation or on the
declaration) work that failed with its retries spent blocks the run instead:
the body never sees the failure, other branches go on, and the run's status
is `blocked` until someone resumes it.

```ts
// After fixing the cause. A resume decided on an older view is refused.
yield * Client.resume(runId, { expectedVersion: run.version })
yield * Client.resume(runId, { blockers: ['publish:intro'] }) // only these
```

- Use `onFailure: 'fail'` where the body handles a failure itself (a
  fallback provider): a blocking operation never reaches its `catch`. A
  durable child's failure is one its body decided, so `d.workflow` on a
  durable child always fails and may not block.
- Resume reruns the same work as the same run: completed work kept, a fresh
  retry budget, the operation's own limits, the same
  `attempt.idempotencyKey`. A mismatch-blocked run is replayed by the code
  deployed now and blocks again if it still does not match.
- A blocked child run is resumed by its own id, not through its parent.
- While blocked the run keeps its unique key, takes inputs and can be
  cancelled; its run timeout keeps counting and resume resets none of it.
- Refused: `RunNotBlocked`, `StaleRunVersion`, `BlockerNotResumable` (an
  operation that does not block it), `RunBusy` while anything under the work
  is still ending, so it never runs twice.
- What blocks is what the body waits on: an operation it let go of (a lost
  race) no longer blocks.
- Find blocked runs with `Client.list({ status: ['blocked'], rootRunId? })`.

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
ms; the run exists at once and is worked from then). `headers` is a string
map (at most 8 KiB as JSON) kept with the run for instrumentation: not
compared by keys, not indexed, fixed for the run's life and copied to the
runs it starts; put a `traceparent` here, never in `tags`. `start` answers with the
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

- `send(Durable | [revisions], runId | { unique, scope? }, family, key,
value)`: an input for a durable run, see [Inputs](#inputs). Fails with
  `InputRefused` (`reason`, `input`, `runId?`, `found?`).
- `resume(runId, { expectedVersion?, blockers? })`: unblocks a blocked
  durable run, see [Blocking and resuming](#blocking-and-resuming).

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
  `inspect` (`{ detail, definition }`); `getDetail` and `inspect` take
  `{ children: true }` to add `childDetails` (one level, with attempts),
  `getDefinition({ kind, name,
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

Run statuses: `queued`, `running`, `waiting`, `blocked` (durable runs only),
`cancelling`, then `completed`, `failed` or `cancelled`.

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
- Tracing, metrics and logs of runs are the application's: see
  [Instrumentation](#instrumentation).

## Instrumentation

The engine emits no spans or metrics, and logs only its own failures; the
application plugs in whatever tracer and metrics it uses. Two pieces:

**Headers**: an opaque `Record<string, string>` kept with a run
(`Client.start(decl, input, { headers })`). Rules:

- Never compared by idempotency or unique keys: a keyed start repeated with
  other headers joins the run, which keeps its own (`created: false`).
- Fixed for the run's life (retry, reopen, resume keep them); runs a step
  starts are created with their parent's, so a family shares one context.
- Schedule fires have none; `restart` gets what its own start gives, not the
  old run's.
- Strings only, at most 8 KiB as JSON; otherwise the start is a defect and
  writes nothing. Not an index: a per-run `traceparent` goes here, never in
  `tags`.
- Handlers read them as `attempt.headers` (`{}` when none), with no hooks.

**`Instrumentation`**: a `Context.Reference`, no-op by default, with three
optional hooks. Provide it with `Layer.succeed(Instrumentation, { ... })`
where each hook runs: the client's process for `start`, execution workers for
the others.

| Hook                            | Runs                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `start(request, next)`          | around `Client.start` / `restart`; `next(headers)` makes the start, `Started.created` |
| `handler(attempt, run)`         | around each handler, in the handler's fiber: a span opened here parents the handler's |
| `attemptEnded(attempt, result)` | once per delivery of an attempt that began, after its worker is done; `Effect<void>`  |

`AttemptResult` is `{ kind: 'settlement', execution: 'completed' | 'failed' |
'timedOut', settlement: 'settled' | 'retrying' | 'stale', error? }`, `{ kind:
'stopped', reason: 'cancelled' | 'claimLost' | 'shutdown' }` or `{ kind:
'error', error: 'storage' | 'cleanupTimeout' | 'defect', cause }`. `failed`
with `settled` means no retry follows, not that the run ended.

`attempt` also carries `kind` (`task` / `activity`), `name` (the task, or the
activity's workflow), `revision`, `attemptId`, `deliveries`, and
`createdAt` / `availableAt` / `claimedAt` by the store's clock: claimed minus
available is the wait for a worker (a retry's backoff is not counted).

```ts
import { Instrumentation } from '@nmtjs/workflows'
import type { Headers } from '@nmtjs/workflows'

const traceparent = (span: Tracer.Span) =>
  `00-${span.traceId}-${span.spanId}-${span.sampled ? '01' : '00'}`
const parentOf = ({ traceparent }: Headers) => {
  const [, traceId, spanId, flags] = traceparent?.split('-') ?? []
  return traceId && spanId
    ? Tracer.externalSpan({ traceId, spanId, sampled: flags === '01' })
    : undefined
}
const attempts = Metric.counter('workflow_attempts')

export const Tracing = Layer.succeed(Instrumentation, {
  start: (request, next) =>
    Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
      next(
        Option.isSome(span)
          ? { ...request.headers, traceparent: traceparent(span.value) }
          : request.headers,
      ),
    ),
  handler: (attempt, run) =>
    Effect.withSpan(run, `${attempt.kind} ${attempt.name}`, {
      kind: 'consumer',
      parent: parentOf(attempt.headers),
      attributes: {
        'workflow.run_id': attempt.runId,
        'workflow.attempt': attempt.attemptNumber,
        'workflow.queued_ms': attempt.claimedAt - attempt.availableAt,
      },
    }),
  attemptEnded: (attempt, result) =>
    Metric.update(
      Metric.withAttributes(attempts, {
        name: attempt.name,
        outcome:
          result.kind === 'settlement'
            ? `${result.execution}:${result.settlement}`
            : result.kind === 'stopped'
              ? result.reason
              : result.error,
      }),
      1,
    ),
})

// API process: Layer.mergeAll(storeLayer, Tracing, otlpLayer)
// Worker:      Worker.execution({ ...served }).pipe(Effect.provide(Tracing))
// Neem:        layer: (ctx) => Layer.mergeAll(handlerServices(ctx), Tracing)
```

- Hooks are trusted middleware: `start` and `handler` must run their
  continuation once and return what it gave. A `handler` hook that fails or
  throws fails the attempt as the handler would. `attemptEnded` failures are
  logged and ignored; it runs before the worker frees the slot, so keep it
  non-blocking (buffer exports).
- The `handler` span ends with the handler, before settlement: read
  `attempt.stopReason` there for why it was stopped; `retrying` / `stale`
  reach only `attemptEnded`.
- Keep metric labels bounded (name, kind, outcome; never run ids).
- For long durable families, prefer a span link to `parentOf(...)` over a
  parent, so one trace does not span days.
- Not covered: coordination passes, run-level events (a run ended) and
  backlog; read those from the store or `Client`.

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

A durable run has no graph: serve `Client.inspect(runId, { children: true })`
and build its view in the browser with `durableView(inspection)`
(`undefined` for a static run):

- `operations`, in the order the run admitted them (an input sent early comes
  before the work it answers): task/workflow with `target`, `childRun`,
  `attempts`, `limits`, `blocked`; `sleep` with `until`; `now`; `input` with
  `family`, `key`, `until`, `receivedAt`, `readAt` and `state`: `waiting`,
  `buffered` (stored, not yet read), `received` (the body read it),
  `timedOut` or `cancelled`.
- `blockers` with advisory `actions`: `operation` (`resume`, `cancel`),
  `mismatch` (`resume` once matching code is deployed), `child` (resume the
  child by `childRunId`). `operation` and `mismatch` show only while the run
  is `blocked`; `child` shows while the parent is active, which may be
  `waiting` on that child. A cancelled or ended run shows none.
- Labels, journey order and progress are the app's, keyed by operation name;
  `readAt` says the body read an input, not that its effects committed.
- Re-read on `Client.watch(runId, { wake: true })` changes and periodically:
  hints are best-effort.

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
  is built only in execution threads. Merge `Instrumentation` into it to
  instrument the thread's handlers.
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
installs, to 7 (`Postgres.migrateFrom4` or `MIGRATION_FROM_4_SQL`, which
refuse while runs or commands are in flight; old runs stay unversioned);
Redis starts empty.
