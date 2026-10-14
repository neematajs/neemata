# @nmtjs/workflows

Durable workflows for Effect applications. You declare tasks and workflows
once, with their schemas and handlers; the engine stores every run, runs each
step as an attempt with retries and timeouts, and continues a run from what
is stored after a crash, a deploy or a restart.

- A **task** is a handler with an input and an output schema. It runs as a
  run of its own.
- A **workflow** is a fixed sequence of steps, known before any run: tasks,
  child workflows, inline activities, branches, parallels and maps.
- A **client** starts, cancels, retries and reads runs.
- **Workers** do the work: a coordinator advances workflow runs, execution
  workers run handlers.
- A **store** holds everything: in memory, PostgreSQL or Redis.

It needs `effect` 4. Handlers are Effects, schemas are `effect/Schema`, and
every operation is an Effect that requires the `Store` service.

Contents: [Quick start](#quick-start) · [Authoring](#authoring) ·
[Client](#client) · [Workers](#workers) · [Revisions](#revisions) ·
[Showing runs in a frontend](#showing-runs-in-a-frontend) ·
[Stores](#stores) · [Hosting in Neem](#hosting-in-neem) ·
[Guarantees and limits](#guarantees-and-limits) ·
[Upgrading from the Promise engine](#upgrading-from-the-promise-engine)

The examples of this guide are run by
[`tests/readme.spec.ts`](./tests/readme.spec.ts). How the engine is built is
in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Quick start

A task, a workflow of two steps, both workers and one run, on the in-memory
store:

```ts
import {
  Client,
  decodeRun,
  InMemory,
  task,
  Worker,
  workflow,
} from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

const Greet = task({
  name: 'greet',
  pool: 'default',
  input: Schema.String,
  output: Schema.String,
  handler: (name) => Effect.succeed(`Hello, ${name}`),
})

const Welcome = workflow(
  {
    name: 'welcome',
    pool: 'default',
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({ greeting: Schema.String, length: Schema.Number }),
  },
  function* (w) {
    // A step that starts a run of the task.
    const greeting = yield* w.task('greet', Greet, {
      input: Effect.map(w.input, ({ name }) => name),
    })
    // A step declared in place, run on the workflow's pool.
    const length = yield* w.activity('measure', {
      input: Schema.String,
      output: Schema.Number,
      from: greeting,
      handler: (text) => Effect.succeed(text.length),
    })
    return Effect.all({ greeting, length })
  },
)

const quickstart = Effect.gen(function* () {
  // Workers run until they are interrupted: here, when the scope closes.
  yield* Effect.forkScoped(Worker.coordinator({ workflows: Welcome.workflows }))
  yield* Effect.forkScoped(
    Worker.execution({ workflows: Welcome.workflows, tasks: Welcome.tasks }),
  )

  const run = yield* Client.start(Welcome, { name: 'Ada' })
  // The stream ends with the status the run ends in.
  yield* Stream.runDrain(Client.watch(run.id))

  const records = yield* Client.get(run.id)
  return decodeRun(Welcome, records!.run).output
}).pipe(Effect.scoped, Effect.provide(InMemory.layer()))

// Effect.runPromise(quickstart) resolves to
// { greeting: 'Hello, Ada', length: 10 }
```

`Welcome.workflows` is the workflow and every child workflow it can start;
`Welcome.tasks` is every task they can start. Those two lists are what
workers take.

## Authoring

### Tasks

`task(options)` declares a task: its name, the pool whose workers run it, its
schemas, its policies and its handler.

```ts
const Order = Schema.Struct({
  id: Schema.String,
  tenant: Schema.String,
  // Text where it is stored, a number wherever code sees it.
  cents: Schema.NumberFromString,
})
const Receipt = Schema.Struct({ id: Schema.String, reference: Schema.String })

/** The payment gateway; the worker supplies it. */
class Gateway extends Context.Service<
  Gateway,
  {
    readonly charge: (
      key: string,
      cents: number,
    ) => Effect.Effect<string, Error>
  }
>()('readme/Gateway') {}

const Charge = task({
  name: 'charge',
  pool: 'payments',
  input: Order,
  output: Receipt,
  retry: { attempts: 3, backoff: 'exponential', delay: '1s' },
  timeout: '30s',
  tags: (order) => ({ tenant: order.tenant }),
  idempotency: (order) => ['charge', order.id],
  unique: {
    key: (order) => ['tenant', order.tenant],
    scope: 'active',
    behavior: 'reject',
  },
  handler: (order, attempt) =>
    Effect.gen(function* () {
      const gateway = yield* Gateway
      // The same key for every attempt of this work, so the gateway charges
      // once however often the handler runs.
      const reference = yield* gateway.charge(
        attempt.idempotencyKey,
        order.cents,
      )
      return { id: order.id, reference }
    }),
})
```

| Option                 | Means                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `name`                 | what runs and the queue call it                                                       |
| `pool`                 | the execution pool whose workers run the handler; required, there is no default       |
| `input`, `output`      | `effect/Schema` schemas; they alone decide the handler's types                        |
| `handler`              | `(input, attempt) => Effect`, see [Handlers](#handlers)                               |
| `retry`                | `{ attempts, backoff?, delay? }`, see [Policies](#policies); one attempt when omitted |
| `timeout`              | limits one attempt, as `'30s'`, `'5m'` (units `ms`, `s`, `m`, `h`, `d`)               |
| `revision`             | pins runs to this exact code, see [Revisions](#revisions)                             |
| `tags`                 | `(input) => Record<string, string>`: tags of every run started from the declaration   |
| `idempotency`          | `(input) => unknown[]`: the idempotency key of every such run                         |
| `unique`               | `(input) => unknown[]`, or `{ key, scope?, behavior? }`: its unique key               |
| `title`, `description` | labels, saved with each run for display                                               |

`workflow(options, body)` takes the same options but `handler` and `retry`.
Its `timeout` limits the whole run, not an attempt. `tags`, `idempotency` and
`unique` apply when a run is started by a client or a schedule; see
[Starting a run](#starting-a-run).

### Workflows

A workflow's body is a generator. Every `w.*` call describes one step, and
`yield*` places it as the next step and returns a reference to its output.
The body returns the workflow's result.

```ts
import { task, workflow } from '@nmtjs/workflows'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/** The payment provider; the worker supplies it. */
export class Payments extends Context.Service<
  Payments,
  {
    readonly charge: (invoice: string, cents: number) => Effect.Effect<string>
  }
>()('billing/Payments') {}

const Order = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(['manual', 'automatic']),
  cents: Schema.NumberFromString,
})
const Invoice = Schema.Struct({ id: Schema.String, cents: Schema.Number })
const Approval = Schema.Struct({ id: Schema.String, approver: Schema.String })
const Receipt = Schema.Struct({ id: Schema.String, paidBy: Schema.String })
const Summary = Schema.Struct({
  order: Schema.String,
  invoice: Schema.String,
  paidBy: Schema.String,
})

export const CreateInvoice = task({
  name: 'billing.invoice',
  pool: 'billing',
  input: Order,
  output: Invoice,
  handler: (order) =>
    Effect.succeed({ id: `inv-${order.id}`, cents: order.cents }),
})

export const ChargeCard = task({
  name: 'billing.charge',
  pool: 'payments',
  input: Invoice,
  output: Receipt,
  retry: { attempts: 3 },
  timeout: '30s',
  handler: (invoice) =>
    Effect.gen(function* () {
      const payments = yield* Payments
      const paidBy = yield* payments.charge(invoice.id, invoice.cents)
      return { id: invoice.id, paidBy }
    }),
})

export const RequestApproval = task({
  name: 'billing.approval',
  pool: 'billing',
  input: Invoice,
  output: Approval,
  handler: (invoice) => Effect.succeed({ id: invoice.id, approver: 'finance' }),
})

export const RecordPayment = task({
  name: 'billing.record',
  pool: 'billing',
  input: Approval,
  output: Receipt,
  handler: (approval) =>
    Effect.succeed({ id: approval.id, paidBy: approval.approver }),
})

/** The manual case takes two steps, so it is a workflow of its own. */
export const ManualBilling = workflow(
  { name: 'billing.manual', pool: 'billing', input: Invoice, output: Receipt },
  function* (w) {
    const approval = yield* w.task('approval', RequestApproval, {
      input: w.input,
    })
    return yield* w.task('record', RecordPayment, { input: approval })
  },
)

export const Billing = workflow(
  {
    name: 'billing',
    pool: 'billing',
    input: Order,
    output: Summary,
    timeout: '1h',
  },
  function* (w) {
    const invoice = yield* w.task('invoice', CreateInvoice, { input: w.input })

    const receipt = yield* w.branch('payment', {
      select: Effect.map(w.input, (order) => order.mode),
      cases: (p) => ({
        manual: p.workflow(ManualBilling, { input: invoice }),
        automatic: p.task(ChargeCard, {
          input: invoice,
          retry: { attempts: 5 },
        }),
      }),
    })

    return Effect.gen(function* () {
      const order = yield* w.input
      return {
        order: order.id,
        invoice: (yield* invoice).id,
        paidBy: (yield* receipt).paidBy,
      }
    })
  },
)
```

This is [`tests/fixtures/billing.ts`](./tests/fixtures/billing.ts);
[`tests/fixtures/fulfillment.ts`](./tests/fixtures/fulfillment.ts) does the
same for activities, parallels and maps; its `Fulfillment` workflow is shown
under [Steps](#steps).

#### Steps

`w` is the builder the body receives; `p` is the one passed to `cases` and
`members`.

| Call                                     | Options                                                                                             | Its reference holds                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `w.activity(name, options)`              | `input`, `output` (schemas), `from`, `handler`, `retry?`, `timeout?`                                | the `output` schema's type                    |
| `w.task(name, Task, options)`            | `input`, `retry?`, `timeout?`                                                                       | the task's output                             |
| `w.workflow(name, Workflow, options)`    | `input`, `cancellation?`                                                                            | the child workflow's output                   |
| `w.branch(name, options)`                | `select`, `cases: (p) => ({ key: case })`                                                           | the union of the cases' outputs               |
| `w.parallel(name, options)`              | `members: (p) => ({ key: member })`                                                                 | `{ [key]: that member's output }`             |
| `w.mapTask(name, Task, options)`         | `item` (schema), `items`, `input: (item, index) => taskInput`, `concurrency?`, `retry?`, `timeout?` | `{ items: { item, index, runId, output }[] }` |
| `w.mapWorkflow(name, Workflow, options)` | `item` (schema), `items`, `input: (item, index) => workflowInput`, `concurrency?`, `cancellation?`  | the same, with the child workflow's output    |
| `p.activity(options)`                    | as `w.activity`, without a name                                                                     |                                               |
| `p.task(Task, options)`                  | as `w.task`, without a name                                                                         |                                               |
| `p.workflow(Workflow, options)`          | as `w.workflow`, without a name                                                                     |                                               |

Every step and case also takes `title` and `description`. `w.input` is the
reference to the workflow's input.

On a task or child workflow step, `input` is the **value** the target
receives. An activity declares its schemas as `input` and `output`, so the
value it receives is named `from`.

- **Activity.** A step declared where it is used: schemas, handler and
  policies in one object. It has no pool of its own and runs on the execution
  workers of its workflow's `pool`. A step that needs its own pool, or is
  shared between workflows, is a task.
- **Task and workflow steps** start a run of the target and take its output.
  `retry` and `timeout` on a task step replace the task's own for that step.
- **Branch.** Every case is declared; `select` picks the one that runs, once
  per run, and the choice is stored. A case is one activity, task or child
  workflow.
- **Parallel.** Every member is started when the run reaches the step. The
  step completes when all have. A member that fails does not stop the others:
  the step fails once every member has settled. Members cannot read one
  another.
- **Maps.** `items` is computed once, when the run reaches the step, and
  stored through the `item` schema. `input` is called once per item, when the
  engine starts it. `concurrency` bounds how many items run at once; all of
  them without it. The output lists the items in their order, whatever order
  they finished in. An empty list completes the step with `{ items: [] }`. A
  failed item does not stop the others: the step fails once every item has
  settled. `retry` and `timeout` on `mapTask` apply to every item on its own.

```ts
export const Fulfillment = workflow(
  {
    name: 'fulfillment',
    pool: 'fulfillment',
    input: Order,
    output: Summary,
  },
  function* (w) {
    // Both members run; neither can read the other.
    const checks = yield* w.parallel('checks', {
      members: (p) => ({
        units: p.activity({
          input: Lines,
          output: Schema.Number,
          from: Effect.map(w.input, (order) => order.lines),
          handler: (lines) =>
            Effect.succeed(lines.reduce((sum, line) => sum + line.quantity, 0)),
        }),
        risk: p.task(Screen, {
          input: Effect.map(w.input, (order) => order.id),
        }),
      }),
    })

    // One Reserve run per line, two at a time.
    const reserved = yield* w.mapTask('reserve', Reserve, {
      item: Line,
      items: Effect.map(w.input, (order) => order.lines),
      input: (line) => Effect.succeed(line),
      concurrency: 2,
    })

    // One Ship child workflow per reserved line.
    const shipped = yield* w.mapWorkflow('ship', Ship, {
      item: Reserved,
      items: Effect.map(reserved, ({ items }) =>
        items.map(({ output }) => output),
      ),
      input: ({ sku, bin }) =>
        Effect.map(w.input, (order) => ({ order: order.id, sku, bin })),
    })

    const note = yield* w.branch('wrap', {
      select: Effect.map(w.input, (order) => (order.gift ? 'gift' : 'plain')),
      cases: (p) => ({
        gift: p.activity({
          input: Schema.String,
          output: Schema.String,
          from: Effect.map(w.input, (order) => order.id),
          handler: (order) => Effect.succeed(`gift receipt for ${order}`),
        }),
        plain: p.activity({
          input: Schema.Number,
          output: Schema.String,
          from: Effect.map(checks, ({ units }) => units),
          handler: (units) => Effect.succeed(`${units} units`),
        }),
      }),
    })

    return Effect.gen(function* () {
      const order = yield* w.input
      const { units, risk } = yield* checks
      const { items } = yield* shipped
      return {
        order: order.id,
        units,
        risk,
        tracking: items.map(({ output }) => output.tracking),
        note: yield* note,
      }
    })
  },
)
```

A case or member with several steps is a workflow: declare it with
`workflow(...)` and use `p.workflow(Child, { input })`. It runs as a child run
with its own input and its own references, so pass what it needs through
`input`. Branches, parallels and maps do not nest in one another for the same
reason.

A failed step fails the run. The steps after it do not run.

#### Build time and run time

| When                         | What runs                                                                   |
| ---------------------------- | --------------------------------------------------------------------------- |
| `task(...)` is called        | nothing of yours                                                            |
| `workflow(...)` is called    | the generator body, once, start to end; the `cases` and `members` callbacks |
| a coordinator advances a run | `select`, `from`, `items`, inputs and the result, when reached              |
| an execution worker runs     | task and activity handlers, with the worker's services                      |

The graph is therefore known before anything runs: both cases of a branch,
every member of a parallel and the one template of a map exist when
`workflow(...)` returns, whatever a run later selects.

The body is ordinary JavaScript and runs at module load. Nothing sandboxes
it: a statement that performs I/O performs it during the build. Keep the body
to step declarations.

#### References are Effects

`yield*` returns a `Ref<Output>`, and `w.input` is a `Ref<Input>`:

```ts
type Ref<A> = Effect.Effect<A, never, Run>
```

A reference is an Effect that needs a **run** to have a value. Building one
runs nothing, and there is nothing to read from it while the workflow is
built, because no run exists yet. `Run` is a service the engine provides when
it computes a value for a run, with the outputs that run has produced.

A value computed from references is ordinary Effect code:

```ts
Effect.map(w.input, (order) => order.mode)

Effect.all({ order: w.input, invoice })

Effect.gen(function* () {
  const order = yield* w.input
  return { order: order.id, invoice: (yield* invoice).id }
})

Effect.succeed('constant')
```

A step's `input`, an activity's `from`, a map's `items`, a branch's `select`
and the workflow's result each take such an Effect. A map's `input` is a
function of the item and its index that returns one.

These Effects run **in the coordinator**, between two steps of a run, and
must be pure and synchronous. The types hold part of that rule:

- The only requirement allowed is `Run`. A handler's services exist on
  execution workers, so `yield* Payments` in a selector is a type error.
- The failure type is `never`. A value that can fail must handle it, or the
  failure is a defect.
- They are run synchronously. One that waits (`Effect.sleep`,
  `Effect.promise`) passes the types and fails with
  `[...] is computed in the coordinator and cannot wait: asynchronous work belongs in a task or an activity`.
- They may run more than once for one step, so they must have no effect of
  their own.

A value that throws fails the step it was computed for, or the run when it is
the result. In a parallel or a map only that member or item fails.

A value reads only what exists when its step starts: the workflow input and
the outputs of earlier steps.

Do not branch on a reference in the body:

```ts
const invoice = yield* w.task('invoice', CreateInvoice, { input: w.input })
if (invoice) { ... } // always true: a Ref is an object
```

TypeScript cannot reject this, and it would describe a different graph per
build, not a decision per run. A decision that depends on a run's values is a
`w.branch`.

### Handlers

A task or activity handler is `(input, attempt) => Effect<Output, unknown, R>`.
It receives the decoded input and returns the decoded output.

- **Services.** `R` is whatever the handler yields. The worker that runs it
  must provide them, and the types of `Worker.execution` require it. Each
  handler is also given a `Scope` that lasts for its attempt, so
  `Effect.acquireRelease` works as it stands.
- **Failure.** A failure and a defect both fail the attempt, which is then
  retried under its policy. The error is stored on the attempt, and on the
  run when it was the last.
- **Stopping.** Interruption is how a handler is told to stop: its run was
  cancelled, its attempt timed out, its worker is shutting down, or its claim
  was lost. There is no signal argument; use Effect's interruption, and
  `Effect.tryPromise` with its `AbortSignal` for Promise APIs.

`attempt` says which work the handler runs:

| Field            | Holds                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| `runId`          | the run the attempt belongs to; for a task, the task's own run              |
| `nodeName`       | the step                                                                    |
| `childKey`       | which child of the step: its only one, a branch's case, a parallel's member |
| `attemptNumber`  | counts every attempt of the work, from 1                                    |
| `idempotencyKey` | one opaque string for every attempt of this work, a manual retry's included |

Pass `idempotencyKey` to whatever must not happen twice. A handler can run
again after it succeeded, when its outcome could not be recorded, so this key
is what keeps a side effect from repeating.

### Schemas and codecs

Schemas are `effect/Schema`. They must decode synchronously and require no
services.

Handlers, clients and computed values see a schema's `Type`; the store holds
its encoded form, which must be JSON. `Schema.NumberFromString` above is a
number in code and text in the store. The engine checks that what is encoded
is JSON and fails the attempt, or refuses the start, when it is not.

A stored value is decoded by the schema of the declaration that wrote it:
`Client.start` answers with a decoded run, and `decodeRun(declaration, run)`
decodes a stored run for the declaration it was started from, and throws for
any other. `declaration.input` and `declaration.output` hold
`{ schema, encode, decode }` when you need a value on the other side.
`InputOf<D>`, `OutputOf<D>` and `Services<D>` give a declaration's types.

### Policies

| Policy         | Where                                | Means                                                                                                                 |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `retry`        | task, activity, task step, `mapTask` | `attempts` in total, the first included; `delay` between them; `backoff: 'exponential'` doubles it after each failure |
| `timeout`      | task, activity, task step, `mapTask` | limits one attempt; a timed-out attempt is retried like a failed one                                                  |
| `timeout`      | workflow                             | limits the whole run; a run past it fails with `RunTimeout` and what it had in flight is cancelled                    |
| `cancellation` | workflow step, `mapWorkflow`         | `'propagate'` (default) cancels the child with its parent; `'detach'` lets it go on                                   |
| `concurrency`  | `mapTask`, `mapWorkflow`             | at most this many items in flight; a positive integer                                                                 |

Without `retry` the work runs once. Without `delay` the next attempt is due
at once. A `retry` on a step replaces the task's policy whole.

A workflow's `timeout` counts from when the run was created, or from its last
manual retry. Coordinators enforce it in a sweep (every 60 seconds by
default), so a run ends up to one sweep late.

### What is rejected, and when

While `task(...)` or `workflow(...)` builds, as a thrown `Error`:

| Mistake                                                       | Error                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| a `revision` that is not a non-empty string                   | `Invalid task revision [...]: expected a non-empty string`                          |
| a missing schema                                              | `Missing schema for ...`                                                            |
| a step name that is no identifier                             | `Invalid workflow node name: ...`                                                   |
| a step named `input`, `__proto__`, `constructor`, `prototype` | `Workflow node name cannot be "..."`                                                |
| a step name used twice                                        | `Duplicate workflow node name: ...`                                                 |
| a case or member key `__proto__`, `constructor`, `prototype`  | `Workflow branch case key cannot be "..."`                                          |
| a plan created and never yielded (a missing `yield*`)         | `Workflow [...] never yielded its plans: ...`                                       |
| `yield plan` without `*`                                      | `Plan [...] must be yielded with yield*`                                            |
| a plan yielded twice                                          | `Plan [...] was already yielded`                                                    |
| anything else yielded, such as a reference                    | `Workflow [...] can only yield plans created by its builder`                        |
| another workflow's plan yielded                               | `Plan [...] belongs to another workflow ...`                                        |
| another workflow's reference handed to a step or returned     | `Reference [...] belongs to another workflow ...`                                   |
| a step plan used as a case or member                          | `Branch case [...] must be built with the cases builder`                            |
| a missing `input`, `from`, `items`, `select` or result        | `[...] needs a reference or an Effect computed from references`                     |
| an activity without a handler                                 | `Missing activity handler [...]`                                                    |
| a map without its per-item `input` function                   | `[...] needs an input callback for its items`                                       |
| a map `concurrency` that is not a positive integer            | `Map node concurrency must be a positive integer`                                   |
| a versioned workflow using an unversioned task or workflow    | `... every task and child workflow of a versioned workflow must declare a revision` |

A reference handed to a step as it is, is checked during the build. An
Effect computed from references is not run during the build, so what it reads
is checked when it runs: reading a reference of another workflow, or of a
later step, throws there and fails the step.

At run time, as a failed step or run: a computed value that throws or waits,
a `select` that names no case (`Unknown branch case [...]`), and a value its
schema does not fit (`Invalid task input [...]`, `Invalid node output [...]`
and the like, with the schema's issues as the cause).

## Client

`Client.*` are Effects that require `Store`. None of them retries: a storage
failure is the caller's to see, so every operation below may also fail with
`StorageError`.

### Starting a run

```ts
// An Effect that requires Store and answers with the run, decoded.
const started = Client.start(Charge, { id: 'o-1', tenant: 'acme', cents: 1200 })
```

`start(declaration, input, options?)` creates a run of a task or a workflow
and answers with it, decoded. It is one commit: the run, the command that
starts it and its saved definition are written together or not at all. The
run is `queued` until a worker takes it.

| Option           | Means                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `tags`           | replaces what the declaration's `tags` builds                            |
| `idempotencyKey` | replaces what the declaration's `idempotency` builds                     |
| `unique`         | `{ key, scope?, behavior? }`; replaces what the declaration's builds     |
| `startAt`        | Unix milliseconds: the run exists at once, and is not worked before this |

**Idempotency key.** It names one request. The same task or workflow, the
same revision and the same input under a key that a run holds is answered
with that run. Anything else under the key fails with `IdempotencyConflict`,
which carries the `runId` that owns it. The key is held for as long as the
run exists.

**Unique key.** It limits how many runs may hold a business key.

- `scope: 'active'` (default): the key is held while the run has not ended.
  `scope: 'all'`: it is held for as long as the run exists.
- `behavior: 'reject'` (default): a start that finds the key held fails with
  `RunConflict`, carrying the holder's `runId` and `status`.
  `behavior: 'join'`: it is answered with the holder instead.

```ts
/** Starts the charge of an order, or names the run its tenant is busy with. */
const admit = (order: typeof Order.Type) =>
  Client.start(Charge, order).pipe(
    Effect.map((run) => ({ started: run.id })),
    Effect.catchTag('RunConflict', ({ runId }) =>
      Effect.succeed({ busyWith: runId }),
    ),
  )
```

`start` fails with `IdempotencyConflict`, `RunConflict`, or
`DefinitionConflict` when the declaration differs from what is saved for its
revision (see [Revisions](#revisions)). An input that does not encode, and a
builder that throws, are defects: nothing is written.

**Transactions.** On PostgreSQL, a client call made inside the caller's
`sql.withTransaction` is part of that transaction: the run commits or rolls
back with the caller's own writes, and workers hear of it when it commits. A
start that is refused there (`IdempotencyConflict`, `RunConflict`,
`DefinitionConflict`) leaves the transaction usable: catch the error and it
goes on to commit its other writes.

```ts
/** An insert of the application's and a run, committed or rolled back as one. */
const placeOrder = (order: typeof Order.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO orders (id) VALUES (${order.id})`
        return yield* Client.start(Charge, order)
      }),
    )
  })
```

### Cancelling

`Client.cancel(runId)` asks a run to stop and answers with the run, or
`undefined` when none has the id. A task run is `cancelled` by the request
itself. A workflow run becomes `cancelling`; its next coordination pass
cancels what it has in flight, child runs included unless their step says
`cancellation: 'detach'`, and ends it as `cancelled`. Handlers of the run are
interrupted. Cancelling a run that has ended changes nothing.

### Retry and restart

Two ways to run failed work again:

|         | `Client.retry(runId, options?)`          | `Client.restart(runId, options)`                       |
| ------- | ---------------------------------------- | ------------------------------------------------------ |
| Run     | the same run, reopened in place          | a new root run                                         |
| Accepts | a `failed` root run                      | a root run that has ended, in any status               |
| Runs    | only what failed; completed work is kept | everything, from the stored input                      |
| Keeps   | id, input, tags, keys, attempt history   | the stored tags and unique constraint, unless replaced |
| Needs   | nothing but the store                    | `definitions`: what the run may be a run of            |

```ts
/**
 * The same run again: only what failed runs, with a fresh retry budget.
 * `version` is the one the caller saw, so a stale request is refused.
 */
const reopen = (runId: string, version: number) =>
  Client.retry(runId, { expectedVersion: version })

/**
 * A new run from the stored input. The declaration's idempotency builder
 * would name the first run again, so the key is replaced.
 */
const chargeAgain = (runId: string) =>
  Client.restart(runId, {
    definitions: [Charge],
    idempotencyKey: ['charge', runId, 'again'],
  })
```

A retry gives each piece of failed work the input its last attempt had and a
fresh retry budget; `attemptNumber` goes on counting. Failed and cancelled
runs under the root are reopened as their parents reach them, and the run's
`timeout` counts from the retry. `expectedVersion` refuses a retry decided on
an older view of the run; a management UI passes the version it displayed.

`retry` fails with `RunNotFound`, `RunNotRoot`, `RunNotFailed`,
`StaleRunVersion`, `RunConflict` when the run's `active` unique key was taken
by another run since, and `RunBusy` while anything of the run's family is
still in flight: a run that has not ended, or a command a worker still holds.
Nothing waits: ask again once it has settled.

`restart` resolves the run to the declaration in `definitions` with its kind,
name and revision, never another revision, and starts it as `start` does, with
the same options. The rules of `start` hold: a declaration whose `idempotency`
builder names the original run answers with that run unless `idempotencyKey`
replaces it, and a constraint of scope `all` conflicts with the run being
restarted. It fails with what `start` fails with, and with `RunNotFound`,
`RunNotRoot`, `RunNotTerminal` and `UnknownDefinition`.

To run finished work on another revision, start that revision yourself with
an input you map: only your code knows how one contract's input becomes
another's.

### Reading runs

| Call                              | Answers with                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Client.get(runId)`               | `{ run, nodes, children, attempts }` as stored, payloads included; `undefined` for no such run            |
| `Client.getDetail(runId)`         | the same without payloads, and `childRuns`: the runs it started                                           |
| `Client.getNode(runId, nodeName)` | one step with its children and their attempts, as stored                                                  |
| `Client.getFamily(runId)`         | every run under the root of the given one, the root included, oldest first                                |
| `Client.list(filter?)`            | `{ runs, nextCursor? }`: runs as stored, newest first                                                     |
| `Client.listSummaries(filter?)`   | the same without payloads, with `nodesTotal` and `nodesCompleted`                                         |
| `Client.inspect(runId)`           | `{ detail, definition }`: the run with the graph it was created with                                      |
| `Client.getDefinition(ref)`       | a saved revision and its graph, by `{ kind, name, revision }`; fails with `DefinitionConflict` if corrupt |

Records hold stored values. `decodeRun(declaration, run)` turns a stored run
into a typed one.

`get`, `getDetail`, `getNode` and `inspect` give a run's records in one order
on every store: nodes by name; children by step, a map's items by index and
any other by key; attempts by child, in the order they were made. Names and
keys compare by code point.

A run id is the exact text the engine gave. The same id in another spelling,
as a uuid in capitals, names no run in any call, on any store.

A list filter takes `kind`, `name`, `revision` (`null` for unversioned runs),
`status` (one or several), `parentRunId` (`null` for root runs), `rootRunId`,
`tags` (every tag given), `input` (JSON containment), `createdBefore`,
`activeBefore`, `limit` (100 when omitted) and `cursor` (the `nextCursor` of
an earlier page of the same filter).

A run is `queued`, `running`, `waiting` (on child runs), `cancelling`, and
ends as `completed`, `failed` or `cancelled`. Times are Unix milliseconds, so
records are plain JSON.

### Watching a run

`Client.watch(runId, options?)` is a `Stream` of `{ kind: 'run', status,
error? }`: the status the run has, then each new status it is found in, and
last the one it ends in. A status that came and went between two reads is
not reported. It is empty for a run that does not exist.

| Option           | Default | Means                                                                              |
| ---------------- | ------- | ---------------------------------------------------------------------------------- |
| `pollIntervalMs` | `1000`  | how often the run is read when no hint comes; what guarantees a change is seen     |
| `wake`           | `false` | also emits `{ kind: 'change' }` on every hint that something of the family changed |
| `debounceMs`     | `0`     | at most one `change` in this long; a status change is never held back              |

`change` events are coarse and best-effort: they do not say what changed, and
one may be missing. A run reopened by a retry is watched anew: the stream
ended when it failed.

### Dead commands

A command a worker keeps failing on is set aside as dead after the store's
`maxDeliveries` (20), and the coordinator's reaper then fails the work it
stood for. `Client.listDeadCommands({ runId?, limit?, cursor? })` lists them
as `{ commands, nextCursor? }`, each with its `command`, `deliveries` and
last `error`. `Client.requeueDeadCommand(id)` queues one again, to be
delivered as if for the first time, and answers `false` when no dead command
has the id: of two callers that ask for one command, one queues it.

### Deleting and pruning

`Client.deleteRun(runId)` deletes a root run that has ended, with every run
under it and all they own, and answers `{ deleted }`: `false` when no run has
the id. It fails with `RunNotRoot`, and with `RunBusy` while a run of the
family has not ended or a worker holds a command of one.

`Client.pruneRuns({ olderThan, statuses?, batchSize? })` deletes the families
of the root runs that ended in one of `statuses` (all three when omitted) and
were not written since `olderThan`, a timestamp, and answers `{ deleted }`.
Families with anything in flight stay. A coordinator does the same on a
timer when given `retention`.

Saved definitions are shared by runs and are never deleted.

### Schedules

`schedule(options)` declares that runs of a task or workflow start by
themselves:

```ts
const NightlyBilling = schedule({
  name: 'billing.nightly',
  runnable: Billing,
  input: { id: 'nightly', mode: 'automatic', cents: 0 },
  cron: '0 2 * * *',
  timeZone: 'Europe/Berlin',
})
```

| Option        | Means                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| `runnable`    | the task or workflow each slot starts a run of                                                |
| `input`       | its input, typed by the runnable                                                              |
| `cron`        | when it fires, as a cron expression; or                                                       |
| `every`       | at a fixed interval of whole milliseconds, as `'15m'` or `'1.5s'`; exactly one of the two     |
| `timeZone`    | the IANA zone `cron` is read in; the declaring process's zone when omitted, stored either way |
| `tags`        | replaces the tags the runnable builds; every run is also tagged `schedule: <name>`            |
| `enabled`     | `true` when omitted                                                                           |
| `immediately` | makes the first slot the moment the schedule is first reconciled                              |

Schedules are given to the coordinator (`schedules`). It makes the stored
schedules those it was given as it starts, **removing any other**, then fires
those that are due. A slot is fired once however many coordinators find it
due. Slots missed while nothing ran, or while a schedule was off, are skipped
and not made up for.

| Call                                    | Does                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `Client.schedules.list()`               | every stored schedule, by name, with `nextRunAt` and `lastSlotAt`          |
| `Client.schedules.trigger(name)`        | starts a run now, beside the slots, whether or not the schedule is enabled |
| `Client.schedules.setEnabled(name, on)` | turns it on or off until the next reconcile says otherwise                 |

`trigger` and `setEnabled` fail with `UnknownSchedule`.

## Workers

Two kinds of worker serve a deployment, and both run until interrupted:

- `Worker.coordinator(options)` advances the runs of the workflows it is
  given: it computes inputs, selectors and results, starts steps and settles
  runs. It runs no handler. It also runs the engine's maintenance.
- `Worker.execution(options)` runs the handlers of tasks and of activities.

```ts
const served = {
  workflows: [Billing, ManualBilling],
  tasks: [CreateInvoice, ChargeCard, RequestApproval, RecordPayment],
}

const NightlyBilling = schedule({
  name: 'billing.nightly',
  runnable: Billing,
  input: { id: 'nightly', mode: 'automatic', cents: 0 },
  cron: '0 2 * * *',
  timeZone: 'Europe/Berlin',
})

// Throws unless everything a served workflow can start is served too, once,
// and every pool a declaration names is one of these.
Worker.verify({ ...served, pools: ['billing', 'payments'] })

const workers = Effect.all(
  [
    Worker.coordinator({
      workflows: served.workflows,
      concurrency: 4,
      schedules: [NightlyBilling],
      retention: { olderThan: '30d', statuses: ['completed'] },
    }),
    Worker.execution({ ...served, pool: 'billing', concurrency: 8 }),
    // ChargeCard runs here, so this worker requires Payments.
    Worker.execution({
      ...served,
      pool: 'payments',
      concurrency: 2,
      cleanupTimeoutMs: 1_000,
    }),
  ],
  { concurrency: 'unbounded', discard: true },
).pipe(
  Effect.provideService(Payments, {
    charge: (invoice, cents) => Effect.succeed(`card:${invoice}:${cents}`),
  }),
)
```

`workers` is an `Effect<void, CleanupTimeout | DefinitionConflict |
StorageError, Store>`: provide a store layer and run it. Each worker can as
well be a process of its own.

### Pools

A pool is a name. A task runs on the pool it declares, and a workflow's
activities run on the workflow's pool. An execution worker given `pool` runs
the handlers of that pool only; without one it runs all it was given. Its
type requires the services of exactly the handlers it runs: above, only the
`payments` worker requires `Payments`.

Workers take partial lists on purpose, so a gap is silent: commands nobody
has code for wait in the queue.
`Worker.verify({ workflows, tasks, schedules?, pools? })` is the check to run
once at startup, with everything the deployment serves. It throws when a task
or child workflow a served workflow can start, or what a schedule starts, is
not served, when a declaration is listed twice or exists as two objects of
one name and revision, and, given `pools`, when a declaration names another
pool.

A worker can also be given `registry` instead of declarations, for programs
written against the engine directly; see `ARCHITECTURE.md`.

### Options

Both workers:

| Option        | Default | Means                                                                 |
| ------------- | ------- | --------------------------------------------------------------------- |
| `concurrency` | `1`     | commands worked on at once by this worker                             |
| `leaseMs`     | `30000` | how long a claim is held without renewal: what a crashed worker costs |
| `pollMs`      | `250`   | how often an idle worker looks for work no hint announced             |

`Worker.execution` also takes `pool`, and `cleanupTimeoutMs` (`5000`): how
long an interrupted handler may take to end, finalizers included.

`Worker.coordinator` also takes the maintenance options:

| Option        | Default                 | Does                                                                                   |
| ------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `reaping`     | every 30 s; `false` off | fails the work dead commands stood for, so no run waits for a command nobody is given  |
| `runTimeouts` | every 60 s; `false` off | fails runs of its workflows that are past their `timeout`                              |
| `schedules`   | none                    | the deployment's schedules, all of them; omitted, stored schedules are left alone      |
| `scheduling`  | every 1 s               | how due schedules are fired, when `schedules` is given                                 |
| `retention`   | none                    | `{ olderThan, statuses? }`: prunes ended root runs older than the duration, every 60 s |

Each of `reaping`, `runTimeouts`, `scheduling` and `retention` takes
`everyMs` and `batchSize` (100). Options a worker cannot run with throw when
the worker is made, before it touches the store.

### Concurrency, leases and heartbeats

`concurrency` is capacity per worker, not a limit across the deployment:
three workers of a pool with two slots run six handlers.

A worker takes a command by claiming it for `leaseMs`. While a handler runs,
its worker renews the claim every third of the lease. A worker that crashes
stops renewing, and its commands are delivered again when their leases end.
The renewal is also how a worker learns that the run was cancelled or has
ended: it then interrupts the handler. With a store that gives hints, that
happens at once instead of at the next renewal.

A handler whose worker lost its claim is interrupted and its outcome
discarded: another delivery owns the work.

Idle workers wake on hints from the store and poll every `pollMs` besides.
Hints are an optimisation; polling is what finds work.

### Attempt timeouts and the cleanup deadline

When an attempt's `timeout` passes, the worker interrupts the handler and
records the attempt as `timedOut`, with an `AttemptTimeout` error. It is
retried like a failure.

An interrupted handler has `cleanupTimeoutMs` to end, counted from the moment
it is interrupted. One that does not yield to interruption cannot be stopped
from outside, so the worker fails with `CleanupTimeout`: the process is to be
replaced. Nothing is settled for
that attempt, and its command is delivered again when its lease ends.

### Shutdown

Interrupting a worker stops it. An execution worker stops claiming,
interrupts its handlers, gives their commands back for another worker without
counting the delivery against them, and is done when the handlers have ended.
A coordinator finishes the passes under way: a pass writes all or nothing and
is never interrupted.

### Storage failures

A storage failure of one command or one maintenance sweep is logged
(`Effect.logError`), the command is given back, and the worker goes on. A
worker fails with `StorageError` only when the store fails it before it
holds anything: a claim, or a coordinator reconciling its schedules as it
starts. An execution worker finishes the handlers it has first.

A coordinator fails with `DefinitionConflict` when a declared schedule's
runnable is not what is saved for its revision.

## Revisions

Without a `revision`, a run is identified by name: whatever code of
`billing` is deployed when a command is claimed runs it, so a deploy changes
the code under runs in flight. A `revision` pins runs instead:

```ts
const ChargeCard = task({
  name: 'billing.charge',
  revision: '2026-10-13',
  ...rest,
})

const Billing = workflow(
  { name: 'billing', revision: '2026-10-13', pool: 'billing', input, output },
  function* (w) {
    return yield* w.task('charge', ChargeCard, { input: w.input })
  },
)

// Every run of it is pinned: `revision` is '2026-10-13' on the run, beside
// `graphHash`, 64 hex characters.
const started = Client.start(Billing, order)
```

A revision is an opaque, non-empty string compared for equality only. It is
never parsed, sorted or treated as "latest". A declaration without one is in
the **unversioned lane**, which is a lane of its own and never a wildcard:
unversioned code does not run versioned runs, nor the other way round.

### Pinning and routing

Work is routed by kind, name and revision, and a worker claims only what it
has code for. Workers may serve any number of revisions of one name side by
side; each needs its own declaration, and its own targets.

A versioned workflow may only use versioned tasks and child workflows
(`workflow(...)` throws otherwise), so a pinned run pins everything it
starts. An unversioned workflow may use anything.

When a revision stops being served while runs still need it, their commands
stay queued, untouched: nothing is claimed and nothing counts against them.
Serving that revision again resumes them. Such a run is also **not timed
out**: a coordinator sweeps only runs of the workflows it holds. Cancelling a
workflow run of an unserved revision records `cancelling` and settles when a
coordinator serving it returns; a task run is cancelled at once.

A run never moves to another revision.

### Saved graphs

Starting a run saves its **graph** under its hash: the names, kinds and order
of its steps and cases. `graphHash` is the SHA-256 of that structure. Labels,
policies, schemas, handlers and revisions are not part of it.

Starting a versioned run also saves an immutable **manifest** for its
revision: the graph hash and the exact revision of every task and child
workflow it can start, cases a run may never take included.

| Field       | Identifies                                          | Changes when                 |
| ----------- | --------------------------------------------------- | ---------------------------- |
| `revision`  | the code a run executes                             | you declare a new `revision` |
| `graphHash` | the run's topology                                  | the graph changes shape      |
| `version`   | one stored record, for `retry({ expectedVersion })` | every write to that record   |

A saved graph is a picture for inspection. It cannot run or read a run: the
codecs that read stored values are the schemas of the declaration, which
exist only in code.

### Drift

Changing the graph, or the revision of a target, under a revision that is
already saved is refused:

- `Client.start` fails with `DefinitionConflict` and creates nothing.
- A worker that serves such code never runs a run with it. The command is
  given back with the conflict as its error, set aside as dead after
  `maxDeliveries`, and the reaper then fails the run with that error.

What is **not** detected: handler bodies, schemas, policies and labels
changed under an unchanged revision. Do that only when runs in flight can go
on with the new code: stored inputs and outputs must still decode. When in
doubt, declare a new revision.

Unversioned runs are not checked: their name alone selects the code.

### Deploying a new revision

1. Deploy workers that serve both revisions, of the workflow and of what it
   starts. Code that imports the new declaration starts new runs on it; runs
   in flight stay on the old one, as do the children they start later.
2. Wait until no run of the old revision is active:

   ```ts
   const stillActive = Client.list({
     name: 'billing',
     revision: 'v1',
     status: ['queued', 'running', 'waiting', 'cancelling'],
   })
   ```

3. Remove the old code.

Which revision new runs get is decided by which declaration your code passes
to `start`. Giving a name its first `revision` does not move its unversioned
runs: keep the unversioned declaration served until they have ended.

A schedule is pinned to the revision and graph of its `runnable` when it is
reconciled, and every fire pins its run to them. Reconciling with a new
revision affects the slots still to come.

### Keys across revisions

Both key spaces are global, so a deploy cannot create a second live
operation for one business key.

- **Idempotency key.** A replay is answered with the run only for the same
  kind, name and revision. The same key with another revision fails with
  `IdempotencyConflict`. A caller that retries a start across a deploy should
  keep the declaration it first started with.
- **Unique key, `reject`.** Any run holding the key refuses the start.
- **Unique key, `join`.** Joins only a run of the same kind, name and
  revision. Otherwise it fails with `RunConflict`, whose `holder` names what
  holds the key. Two unversioned runs join whatever they are.

## Showing runs in a frontend

`@nmtjs/workflows/inspector` imports no Node API, so a browser bundle
can use it. The server, which already imports the
declarations, sends graphs and runs as JSON; the browser never imports a
module that declares a workflow.

```ts
import type { RunInspection } from '@nmtjs/workflows/inspector'
import {
  nodeUnits,
  renderWorkflowGraph,
  serializeWorkflowCatalog,
  serializeWorkflowGraph,
} from '@nmtjs/workflows/inspector'

// Server: the graph deployed now, and everything the workers serve.
const graph = serializeWorkflowGraph(Billing)
const catalog = serializeWorkflowCatalog({
  workflows: Billing.workflows,
  tasks: Billing.tasks,
})

// Server: one run with the graph it was created with, from the store alone.
const inspectRun = (runId: string) => Client.inspect(runId)

// Browser: an inspection arrives as JSON; the helpers need nothing else.
const draw = ({ detail, definition }: RunInspection) => ({
  graph:
    definition.source === 'saved' && definition.structure.kind === 'workflow'
      ? renderWorkflowGraph(definition.structure, definition.presentation)
      : undefined,
  // The children of one step, each with its attempts and its child run.
  payment: nodeUnits(detail, 'payment'),
})
```

`serializeWorkflowGraph(Billing)` is:

```json
{
  "name": "billing",
  "nodes": [
    {
      "name": "invoice",
      "kind": "task",
      "target": { "kind": "task", "name": "billing.invoice" }
    },
    {
      "name": "payment",
      "kind": "branch",
      "cases": [
        {
          "key": "manual",
          "kind": "workflow",
          "target": { "kind": "workflow", "name": "billing.manual" }
        },
        {
          "key": "automatic",
          "kind": "task",
          "target": { "kind": "task", "name": "billing.charge" }
        }
      ]
    }
  ]
}
```

There are two graphs to draw from, and they answer different questions:

- **The definition deployed now**: `serializeWorkflowGraph(declaration)` and
  `serializeWorkflowCatalog(...)`.
- **A run as it was created**: `Client.inspect(runId)`, from the store alone,
  so a run whose code is long gone can still be shown. When
  `definition.source` is `'saved'`, `structure` has the steps in declared
  order with every alternative, `presentation` the labels the run was created
  with, and `revision.bindings` the revision each target runs.
  `renderWorkflowGraph(structure, presentation)` gives the same shape as
  `serializeWorkflowGraph`. When it is `'observed'`, no trustworthy graph
  exists for the run (`reason`: `'legacy'`, `'missing-graph'` or
  `'invalid-graph'`): `detail` still lists everything that ran, and nothing
  may be filled in from the definition deployed today.

`Client.getDefinition({ kind, name, revision })` loads a saved revision and
its graph, to show a target no run has reached: a child that has not started,
a case that was not taken. It has the structure and not the labels.

How one run maps onto the graph:

| In the graph                            | In one run (`RunDetail`)                                        |
| --------------------------------------- | --------------------------------------------------------------- |
| a `branch` with all of its `cases`      | the node's `selectedCase`, and one child `case:<key>`           |
| a `parallel` with all of its `cases`    | one child per member, `member:<key>`, each with its status      |
| one `mapTask` / `mapWorkflow` node      | one child per item, `item:<index>`, each with its own child run |
| an `activity`, or a `task` / `workflow` | one child, `$self`, with its attempts or its child run          |
| a `target` naming a child workflow      | `childRuns`; that workflow's own graph is fetched by its name   |

`nodeUnits(detail, nodeName)` does that join for one step: each child with
its attempts and its child run, map items in their order.
`parseChildKey(key)` reads a child key back. The one node of a task run is
named `TASK`, and `isTerminal(status)` says whether a status ends a run.

The graph leaves out schemas, policies and the steps of child workflows: a
child workflow is one `target`, and its steps are its own graph.

The inspector entry also exports the record types (`RunDetail`,
`RunInspection`, `RunSummary`, `StoredNode`, ...) for typing what the
browser receives. Hashing (`hashStructure`, `describeDefinition`) needs
`node:crypto` and is in the main entry.

## Stores

A store is a `Layer` that provides `Store`. The client and the workers of one
deployment must be given the same store.

### In memory

```ts
import { InMemory } from '@nmtjs/workflows'

const store = InMemory.layer({ maxDeliveries: 20 })
```

Everything lives in the process and is lost with it. For tests and local
development. Each `InMemory.layer()` built is a store of its own.
`InMemory.makeInMemoryStore()` gives the store with an `inspect` handle on
its contents, for tests.

### PostgreSQL

On Effect SQL: any `SqlClient` for PostgreSQL serves, `@effect/sql-pg` and
`@effect/sql-pglite` included.

```ts
import { PgClient } from '@effect/sql-pg'
import * as Postgres from '@nmtjs/workflows/postgres'
import * as PostgresPg from '@nmtjs/workflows/postgres/pg'

const store = Postgres.layer({ maxDeliveries: 20 }).pipe(
  // Optional: without it workers find their work by polling alone.
  Layer.provide(PostgresPg.notifications),
  Layer.provide(PgClient.layer({ url })),
)
```

The same on PGlite, PostgreSQL in the process:

```ts
// PGlite: PostgreSQL in the process, for tests and local development.
const database = Layer.orDie(PgliteClient.layer())
const store = Postgres.layer().pipe(
  // Optional: without it workers find their work by polling alone.
  Layer.provide(PostgresPglite.notifications),
  // `install` is for tests; production migrations are the application's.
  Layer.provide(Layer.effectDiscard(Effect.orDie(Postgres.install))),
  Layer.provideMerge(database),
)
```

The schema is the application's to migrate.
`@nmtjs/workflows/postgres/drizzle` exports it as Drizzle objects
(`createSchema()`), `Postgres.install` creates it on an empty database for
tests, and `Postgres.verify` dies at startup unless the installed schema is
the one the adapter needs. Engine calls take part in the caller's
transaction, as [shown above](#starting-a-run).

Options (`maxDeliveries`, `channel`, `answerTimeoutMs`), how commits are
guarded, the tables and the migration:
[`src/postgres/README.md`](./src/postgres/README.md). A database that stops
answering holds a transaction's `COMMIT`, and with it a worker's stop, for as
long as the client waits: `PostgresPg.stream` gives `@effect/sql-pg` a
deadline for answers, which a deployment whose workers must stop in time
needs.

### Redis

On Effect's `Redis` service (`effect/persistence/Redis`); Valkey serves too.

```ts
import { NodeRedis } from '@effect/platform-node'
import * as Redis from '@nmtjs/workflows/redis'

const store = Redis.layer({ prefix: 'billing:', maxDeliveries: 20 }).pipe(
  Layer.provide(NodeRedis.layer({ url })),
)
```

It passes the same store contract as the others, schedules and retention
included. Durability is the server's: run it with `maxmemory-policy
noeviction`, and know what your persistence settings may lose on a crash or
a failover. No key expires; history stays until it is pruned. Limits, the
key layout and cluster use: [`src/redis/README.md`](./src/redis/README.md).

## Hosting in Neem

`@nmtjs/workflows/neem` runs the workers as Neem worker threads:
coordinator threads, and execution threads for each pool.

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
// workflows.planner.ts: the thread layout; it loads no application code.
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1, concurrency: 4 },
  pools: {
    billing: { concurrency: 8 },
    payments: { threads: 2, cleanupTimeoutMs: 1_000 },
  },
}))
```

```ts
// workflows.worker.ts: what every thread serves.
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem/worker'

export default defineWorkflowsWorker({
  workflows: [Billing, ManualBilling],
  tasks: [CreateInvoice, ChargeCard, RequestApproval, RecordPayment],
  schedules: [NightlyBilling],
  store: () => Postgres.layer().pipe(Layer.provide(database)),
  layer: (ctx) => Layer.succeed(Payments, payments(ctx.logger)),
})
```

The plan's `coordinator` and each pool take `threads` and the options of the
worker they run. Every pool a declaration names must be in the plan. A thread
starts only if `Worker.verify` accepts what is served and scheduled, and the type of
`layer` requires it to provide every handler's services. Threads share runs
only through a durable store. Details, logging and stopping:
[`src/neem/README.md`](./src/neem/README.md).

## Guarantees and limits

**What the engine guarantees**

- A run that was started is worked until it ends, across crashes and
  deploys, as long as some worker serves its code.
- Every write is one all-or-nothing commit: a run with the command that
  starts it, an attempt's outcome with what it leads to.
- An outcome counts once. Only the delivery that holds a command's claim can
  settle its attempt; a late one changes nothing.
- A schedule's slot is fired once.

**What you must provide**

- **Handlers run at least once.** A handler can run again after it failed,
  after its worker crashed, and after it succeeded but its outcome was not
  recorded. Make side effects idempotent with `attempt.idempotencyKey`.
- **Computed values are pure.** Inputs, selectors and results may be computed
  more than once.
- **Stored values stay readable.** A run's values are read by the code
  deployed when they are read. Change schemas under a revision, or in the
  unversioned lane, only compatibly.

**What a retry re-runs**

- An automatic retry re-runs one handler, on the same input.
- A manual `Client.retry` re-runs the steps, members and items that did not
  complete, on the input their last attempt had, and computes again what
  never got as far as starting. Completed steps keep their outputs; a map's
  `items` are not computed again.

**What is not supported**

- Steps decided at run time: loops whose count depends on a run, `if` on a
  run's values, recovering from a failed step in the workflow. Use `branch`
  and maps; a failed step fails the run.
- Branches, parallels or maps nested in one another, a map over activities,
  a member reading another member, cancelling siblings when one fails.
- Waiting inside a workflow for a signal, an event or a timer. A run can be
  delayed as a whole with `startAt`.
- Limits across a deployment: `concurrency` is per worker, a map's per step.
- Moving a run to another revision.
- Schemas other than `effect/Schema`, and handlers that are not Effects.
- Declaring a task or workflow without its handlers, for a client-only
  bundle: a module that starts runs imports the declaration whole.
- Collecting saved definitions: they are small, bounded by how many graphs
  and revisions were ever deployed, and stay.

## Upgrading from the Promise engine

Up to `0.18.0-alpha.4`, `@nmtjs/workflows` was a Promise-based engine with
optional Effect entry points. This engine replaces it under the same name.
The model is the same: static graphs, durable runs, attempts, pools. The
API and the storage are not, and revisions are new: every run the old
engine made is unversioned. The tables below compare with the published
`0.18.0-alpha.4`.

### Entry points

| Before                                             | Now                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@nmtjs/workflows`, `@nmtjs/workflows/effect`      | `@nmtjs/workflows`                                                               |
| `@nmtjs/workflows/runtime`                         | `@nmtjs/workflows` (`Client`, `Worker`, `InMemory`)                              |
| `@nmtjs/workflows/inspector`                       | `@nmtjs/workflows/inspector`                                                     |
| `@nmtjs/workflows/postgres`, `/postgres/effect`    | `@nmtjs/workflows/postgres`, with `/postgres/pg` or `/postgres/pglite` for hints |
| `@nmtjs/workflows/postgres/testing`                | `Postgres.install` from `@nmtjs/workflows/postgres`                              |
| `@nmtjs/workflows/postgres/drizzle`                | `@nmtjs/workflows/postgres/drizzle`                                              |
| `@nmtjs/workflows/redis`                           | `@nmtjs/workflows/redis`                                                         |
| `@nmtjs/workflows/neem`, `/effect/neem`            | `@nmtjs/workflows/neem` (planner), `/neem/worker` (worker)                       |
| `@nmtjs/workflows/neem/host`, `/neem/worker-entry` | none: the planner and `/neem/worker` are the entries Neem loads                  |

### Authoring

| Before                                                                                                   | Now                                                                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `defineTask(...)` + `implementTask(def, { pool, handler })`                                              | `task({ ..., pool, handler })`                                            |
| `defineWorkflow(...).activity(...).task(...).build()` + `implementWorkflow(def, { pool })...finish(...)` | `workflow({ ..., pool }, function* (w) { ... })`                          |
| `.finish((outputs, input) => ...)`                                                                       | the value the body returns: an Effect computed from references            |
| mappers `(outputs, workflowInput) => value`                                                              | Effects over references: `Effect.map(w.input, ...)`                       |
| a step's `input` omitted, meaning the workflow input                                                     | always written: `{ input: w.input }`                                      |
| `parallel(name, callback)`                                                                               | `w.parallel(name, { members: (p) => ({ ... }) })`                         |
| Standard Schema (Zod, Valibot, ...) or `{ decode, encode }` pairs                                        | `effect/Schema` only; a transformation is one schema                      |
| handler `(input, lifecycle, env)`, `lifecycle.signal`                                                    | handler `(input, attempt)`; interruption stops it; services replace `env` |
| per-step and per-item `idempotency` callbacks                                                            | `attempt.idempotencyKey`, made by the engine                              |
| `defineSchedule(...)`                                                                                    | `schedule(...)`, with the new `timeZone`                                  |

### Client

`createWorkflowRuntimeClient(runtime)` and its Promise methods become the
`Client` module, whose functions are Effects requiring `Store`.

| Before                                                | Now                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `client.start(definition, input, options)`            | `Client.start(declaration, input, options)`                     |
| `options.connection`, `createEffectSqlWorkflowClient` | call `Client.*` inside `sql.withTransaction`                    |
| `client.restart(runId)`, `definitions` on the client  | `Client.restart(runId, { definitions })`                        |
| `client.watch(runId)`: `AsyncIterable`, `signal`      | `Client.watch(runId)`: `Stream`; interrupt it to stop           |
| `client.listDeadCommands()`: an array                 | `Client.listDeadCommands()`: `{ commands, nextCursor? }`, paged |
| `client.requeueDeadCommand(id)`: `void`               | answers `boolean`: whether a dead command had the id            |
| `isTerminalRunStatus(status)`                         | `isTerminal(status)`                                            |
| `run.workflowName`, `run.taskName`                    | `run.kind` and `run.name`                                       |
| `StoredNodeChild`                                     | `StoredChild`                                                   |

`cancel`, `retry`, `deleteRun`, `get`, `getDetail`, `getNode`, `getFamily`,
`list`, `listSummaries`, `pruneRuns` and `schedules.*` keep their names and
meanings: `pruneRuns` takes the same parameters and, as before, goes on
batch by batch until nothing is left that may go, answering `{ deleted }`.

### Errors

Errors are tagged and in the Effect failure channel; match them with
`Effect.catchTag`.

| Before                                            | Now                              |
| ------------------------------------------------- | -------------------------------- |
| `WorkflowRunConflictError`                        | `RunConflict`                    |
| `WorkflowIdempotencyConflictError`                | `IdempotencyConflict`            |
| `WorkflowCleanupTimeoutError`                     | `CleanupTimeout`                 |
| `Error('Run [...] not found')`                    | `RunNotFound`                    |
| `Error('Run [...] is not a root run')`            | `RunNotRoot`                     |
| `Error('Run [...] is not failed')`                | `RunNotFailed`                   |
| `Error('Run [...] is not terminal')`              | `RunNotTerminal`                 |
| `Error('Stale retry version ...')`                | `StaleRunVersion`                |
| `Error('Run family [...] still has active work')` | `RunBusy`, with `busyRunId`      |
| a restart without a matching definition           | `UnknownDefinition`              |
| an unknown schedule                               | `UnknownSchedule`                |
| a failure of the database or Redis client         | `StorageError`, with the `cause` |

### Workers and hosting

| Before                                                                                                                                             | Now                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `serveWorkflowWorker({ ...runtime, workflows, workerId })`                                                                                         | `Worker.coordinator({ workflows })`                                                                                           |
| `serveExecutionWorker({ ...runtime, workflows, tasks, pool })`                                                                                     | `Worker.execution({ workflows, tasks, pool })`                                                                                |
| `runWorkflowWorker`, `runExecutionWorker` (drain once)                                                                                             | none: workers run until interrupted                                                                                           |
| `env`, `context`, `createHandlerRuntime`                                                                                                           | provide the handlers' services to the worker Effect                                                                           |
| `pollIntervalMs`                                                                                                                                   | `pollMs`                                                                                                                      |
| `workerId`                                                                                                                                         | none                                                                                                                          |
| `createInMemoryWorkflowRuntime()`                                                                                                                  | `InMemory.layer()`                                                                                                            |
| `createPostgresWorkflowRuntime({ connection })`                                                                                                    | `Postgres.layer()` over an Effect `SqlClient`                                                                                 |
| `createPostgresWorkflowWakeEvents(...)`                                                                                                            | `Layer.provide(PostgresPg.notifications)`                                                                                     |
| `verifyPostgresWorkflowSchema(connection)`                                                                                                         | `Postgres.verify`                                                                                                             |
| `createRedisWorkflowRuntime({ client, keyPrefix })`                                                                                                | `Redis.layer({ prefix })` over Effect's `Redis` service                                                                       |
| Neem `defineWorkflowsWorker({ workflows: () => [...], tasks: () => [...], runtime, layer })` from `/effect/neem`, or `{ ..., setup }` from `/neem` | `defineWorkflowsWorker({ workflows: [...], tasks: [...], store: (ctx) => Layer, layer: (ctx) => Layer })` from `/neem/worker` |
| Neem plan: `pollIntervalMs`; `cleanupTimeoutMs` on the coordinator                                                                                 | `pollMs`; `cleanupTimeoutMs` on pools only                                                                                    |

### Behaviour that differs

- **Maintenance is the coordinator's.** Reaping, run timeouts, schedules and
  retention run in `Worker.coordinator` only. A deployment needs at least one
  coordinator for dead commands to be reaped.
- **Results are computed, not run.** The old `finish` could be an Effect with
  services; the result is now a pure value computed in the coordinator. Work
  that waits or needs services belongs in a last activity.
- **No abort reason.** A handler is interrupted and cannot ask why. If it
  must tell a timeout from a cancellation, it cannot; clean up the same way
  for both.
- **Schedules have a time zone.** A cron schedule is read in its stored
  `timeZone`. A schedule carried over from the old engine has none until a
  coordinator reconciles it.
- **Restart takes its definitions per call**, and a declaration's
  `idempotency` builder applies to it: see [Retry and restart](#retry-and-restart).
- **Redis keeps history.** The old Redis runtime expired ended runs
  (`terminalRetentionMs`); nothing expires now. Configure `retention` on the
  coordinator, or call `Client.pruneRuns`. Redis also has schedules now.
- **`Effect.log*` under Neem** goes to the worker's logger.
- **Not carried over:** `toStoredJsonSchema`, `createContract`, and Promise
  handlers.

### Upgrading the storage

Runs in flight are **not** converted on either store: their records and
commands are the old engine's, which the new one cannot continue. In every
case:

1. Stop starting runs on the old engine and let it finish, or cancel, what
   it has.
2. Stop every process of the old engine.
3. Upgrade the storage as below, then start the new engine.

**PostgreSQL: generation 4 to 6.** `0.18.0-alpha.4` installs schema
generation 4; a database at an earlier generation applies that release's
upgrades to 4 first. The migration keeps history, identity keys and
schedules in place, all unversioned, and rebuilds the command queue. It
**refuses to run** unless the generation is 4, every run has ended and no
command is queued. `Postgres.migrateFrom4` runs it in the process;
`Postgres.MIGRATION_FROM_4_SQL` is the same as a script, which refuses the
few databases whose keys SQL cannot carry over exactly and names their runs.
What it changes, column by column:
[Migrating from generation 4](./src/postgres/README.md#migrating-from-generation-4).

**Redis: starts empty.** Nothing is converted. History and identity keys are
not carried over, so a start that repeats a key of an old run creates a new
run. The two engines share no key, even under one prefix. What is left
behind and when to delete it:
[Moving from the Promise engine](./src/redis/README.md#moving-from-the-promise-engine).
