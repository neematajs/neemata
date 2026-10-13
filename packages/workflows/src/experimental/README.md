# Single-source workflow authoring (experimental)

`@nmtjs/workflows/experimental` declares a task or a workflow **once** and
builds the two objects the existing engine already takes: the contract
(`defineTask` / `defineWorkflow`) and the implementation (`implementTask` /
`implementWorkflow`). Schemas, handler, pool and policies sit in one place, and
the workflow's steps are written once instead of once per object: tasks, child
workflows, inline activities, branches, parallels and maps.

It is an authoring layer. It adds no engine, store, table, worker or replay
mechanism, and it changes none: the existing engine runs what it builds, with
its existing semantics. It is also **not**:

- the native Effect engine in [`../native-effect`](../native-effect/README.md),
  which this module does not import, use or alter;
- a way to extract a graph from an arbitrary `Effect.gen` program. The workflow
  body is a plain TypeScript generator over a small set of step constructors.
  Effect appears only inside task and activity handlers, where any Effect
  program is fine.

Status: experimental, covered by the tests under [Validation](#validation) on
the in-memory runtime only. The API may change without notice.

## Example: manual or automatic billing

Tested as [`tests/fixtures/experimental/billing.ts`](../../tests/fixtures/experimental/billing.ts).

```ts
import { task, workflow } from '@nmtjs/workflows/experimental'
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
      select: (read) => read(w.input).mode,
      cases: (p) => ({
        manual: p.workflow(ManualBilling, { input: invoice }),
        automatic: p.task(ChargeCard, {
          input: (read) => read(invoice),
          retry: { attempts: 5 },
        }),
      }),
    })

    return (read) => ({
      order: read(w.input).id,
      invoice: read(invoice).id,
      paidBy: read(receipt).paidBy,
    })
  },
)
```

The equivalent with the existing API declares `invoice` and `payment`, both
case keys and both targets in `defineWorkflow(...)`, then repeats all of them
in `implementWorkflow(...)`, and declares each task's contract and
implementation separately.

## Example: activities, parallel and maps

Tested as [`tests/fixtures/experimental/fulfillment.ts`](../../tests/fixtures/experimental/fulfillment.ts).

```ts
import { task, workflow } from '@nmtjs/workflows/experimental'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/** The carrier API; the worker supplies it. */
export class Carriers extends Context.Service<
  Carriers,
  { readonly book: (order: string, sku: string) => Effect.Effect<string> }
>()('fulfillment/Carriers') {}

const Line = Schema.Struct({
  sku: Schema.String,
  quantity: Schema.NumberFromString,
})
const Lines = Schema.Array(Line)
const Order = Schema.Struct({
  id: Schema.String,
  gift: Schema.Boolean,
  lines: Lines,
})
const Risk = Schema.Literals(['low', 'high'])
const Reserved = Schema.Struct({ sku: Schema.String, bin: Schema.String })
const Parcel = Schema.Struct({
  order: Schema.String,
  sku: Schema.String,
  bin: Schema.String,
})
const Label = Schema.Struct({ sku: Schema.String, tracking: Schema.String })
const Summary = Schema.Struct({
  order: Schema.String,
  units: Schema.Number,
  risk: Risk,
  tracking: Schema.Array(Schema.String),
  note: Schema.String,
})

export const Screen = task({
  name: 'fulfillment.screen',
  pool: 'risk',
  input: Schema.String,
  output: Risk,
  handler: (order) => Effect.succeed(order.startsWith('x') ? 'high' : 'low'),
})

export const Reserve = task({
  name: 'fulfillment.reserve',
  pool: 'warehouse',
  input: Line,
  output: Reserved,
  handler: ({ sku, quantity }) =>
    Effect.succeed({ sku, bin: `bin-${quantity}` }),
})

/** One parcel. Its activity runs on the `shipping` pool and needs Carriers. */
export const Ship = workflow(
  { name: 'fulfillment.ship', pool: 'shipping', input: Parcel, output: Label },
  function* (w) {
    return yield* w.activity('label', {
      input: Parcel,
      output: Label,
      from: w.input,
      retry: { attempts: 3 },
      timeout: '30s',
      handler: ({ order, sku }) =>
        Effect.gen(function* () {
          const carriers = yield* Carriers
          const tracking = yield* carriers.book(order, sku)
          return { sku, tracking }
        }),
    })
  },
)

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
          from: (read) => read(w.input).lines,
          handler: (lines) =>
            Effect.succeed(lines.reduce((sum, line) => sum + line.quantity, 0)),
        }),
        risk: p.task(Screen, { input: (read) => read(w.input).id }),
      }),
    })

    // One Reserve run per line, two at a time.
    const reserved = yield* w.mapTask('reserve', Reserve, {
      item: Line,
      items: (read) => read(w.input).lines,
      input: (_read, line) => line,
      concurrency: 2,
    })

    // One Ship child workflow per reserved line.
    const shipped = yield* w.mapWorkflow('ship', Ship, {
      item: Reserved,
      items: (read) => read(reserved).items.map(({ output }) => output),
      input: (read, { sku, bin }) => ({ order: read(w.input).id, sku, bin }),
    })

    const note = yield* w.branch('wrap', {
      select: (read) => (read(w.input).gift ? 'gift' : 'plain'),
      cases: (p) => ({
        gift: p.activity({
          input: Schema.String,
          output: Schema.String,
          from: (read) => read(w.input).id,
          handler: (order) => Effect.succeed(`gift receipt for ${order}`),
        }),
        plain: p.activity({
          input: Schema.Number,
          output: Schema.String,
          from: (read) => read(checks).units,
          handler: (units) => Effect.succeed(`${units} units`),
        }),
      }),
    })

    return (read) => ({
      order: read(w.input).id,
      units: read(checks).units,
      risk: read(checks).risk,
      tracking: read(shipped).items.map(({ output }) => output.tracking),
      note: read(note),
    })
  },
)
```

For an order of three lines with quantities 2, 3 and 1, and a `Carriers` that
books `` `${order}-${sku}` ``, the run's output is
`{ order: 'o-1', units: 6, risk: 'low', tracking: ['o-1-a', 'o-1-b', 'o-1-c'], note: '6 units' }`,
or `note: 'gift receipt for o-1'` when `gift` is set.

## Syntax

`w` is the builder a workflow body receives; `p` is the one passed to `cases`
and `members`. Every `w.*` call returns a plan to `yield*`.

| Call                                     | Options                                                                                                             | Reference it yields                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `w.activity(name, options)`              | `input`, `output` (schemas), `from`, `handler`, `retry?`, `timeout?`, `title?`, `description?`                      | the `output` schema's type                    |
| `w.task(name, Task, options)`            | `input`, `retry?`, `timeout?`, `title?`, `description?`                                                             | the task's output                             |
| `w.workflow(name, Workflow, options)`    | `input`, `cancellation?`, `title?`, `description?`                                                                  | the child workflow's output                   |
| `w.branch(name, options)`                | `select`, `cases: (p) => ({ key: case })`, `title?`, `description?`                                                 | the union of the cases' outputs               |
| `w.parallel(name, options)`              | `members: (p) => ({ key: member })`, `title?`, `description?`                                                       | `{ [key]: that member's output }`             |
| `w.mapTask(name, Task, options)`         | `item` (schema), `items`, `input: (read, item, index) => taskInput`, `concurrency?`, `retry?`, `timeout?`, metadata | `{ items: { item, index, runId, output }[] }` |
| `w.mapWorkflow(name, Workflow, options)` | `item` (schema), `items`, `input: (read, item, index) => workflowInput`, `concurrency?`, `cancellation?`, metadata  | the same, with the child workflow's output    |
| `p.activity(options)`                    | as `w.activity`, without a name                                                                                     | —                                             |
| `p.task(Task, options)`                  | as `w.task`, without a name                                                                                         | —                                             |
| `p.workflow(Workflow, options)`          | as `w.workflow`, without a name                                                                                     | —                                             |

Option names are the existing API's, with two additions:

- `input` and `output` on an activity, and `item` on a map, are **schemas**, as
  they are in `defineWorkflow(...).activity(...)` and `.mapTask(...)`.
- `input` on a task or child workflow step is the **value** it receives, and on
  a map the callback producing one item's input, as in `implementWorkflow`.
- An activity declares both in one place, so the value it receives is named
  `from`.
- `members` names the callback the existing `parallel(name, callback)` takes by
  position. The engine calls them members too; the serialized graph lists them
  under `cases`, as it does for hand-written contracts.

`from`, a step's `input`, a map's `items` and the workflow's result are each a
reference or a deferred callback `(read) => value`. `select` and a map's
`input` are always callbacks.

## What a declaration builds

`task(options)` returns

| Field            | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| `contract`       | the `TaskDefinition` that `defineTask` returns for the options |
| `implementation` | the `TaskImplementation` that `implementTask` returns for it   |

`workflow(options, body)` returns

| Field            | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `contract`       | the `WorkflowDefinition`, built by the existing `defineWorkflow`   |
| `implementation` | its `WorkflowImplementation`, holding its activities' handlers     |
| `workflows`      | that implementation and those of every child workflow it can start |
| `tasks`          | the implementation of every task it or a child workflow can start  |

These are ordinary definitions and implementations. Clients start runs from
`contract`, workers register `workflows` and `tasks`, and the inspector reads
`contract`, exactly as for hand-written ones. A module that only needs to start
runs still imports the handlers along with the contract; splitting the two for
client bundles is not solved here.

### Revisions

`task` and `workflow` accept the same optional `revision` as `defineTask` and
`defineWorkflow`, and pass it to the contract they build:

```ts
const ChargeCard = task({
  name: 'card.charge',
  revision: '2026-10-13',
  ...rest,
})

const Billing = workflow(
  { name: 'billing', revision: '2026-10-13', pool: 'billing', input, output },
  function* (w) {
    return yield* w.task('charge', ChargeCard, { input: w.input })
  },
)
```

Runs started from `Billing.contract` are pinned to that revision, and workers
may register `Billing.workflows` and `Billing.tasks` of several revisions side
by side. A versioned workflow may only use versioned tasks and child workflows;
declaring one that does not throws. Everything else is the engine's behavior,
described in the package README under "Revisions".

### The graph is known before anything runs

`workflow(...)` runs the generator body once, at the call, and never calls a
handler, a selector, a deferred input or a deferred result while doing so. Both
cases of a branch, every member of a parallel and the one template of a map are
built at that point, whatever a run later selects or however many items it
maps. For the billing example, `serializeWorkflowGraph(Billing.contract)` from
`@nmtjs/workflows/inspector` gives:

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

The inspector does not descend into child workflows. The manual case's two
steps are the graph of `ManualBilling.contract`: `approval`, then `record`.
Schemas and policies are on the contract as usual, for example
`toStoredJsonSchema(Billing.contract.input)` and
`Billing.contract.nodes[1].cases.automatic.retry`.

## Showing a workflow in a frontend

This section shows the graph of the definition deployed now. To show a run as
it was created, including runs whose code has since changed or been removed,
use `client.inspect(runId)` instead; see "Inspecting historical runs" in the
package README.

The graph is data, and a frontend needs nothing else from the definition. The
server, which already imports the workflow, serializes it with the existing
inspector and returns JSON; the browser never imports the module that declares
the workflow, so no handler, schema or service reaches the bundle.

```ts
// Server: an API route. The same functions serve hand-written contracts.
import {
  serializeWorkflowCatalog,
  serializeWorkflowGraph,
} from '@nmtjs/workflows/inspector'

import { Fulfillment } from './fulfillment.ts'

export const graph = () => serializeWorkflowGraph(Fulfillment.contract)

// Every workflow and task the worker serves, child workflows included.
export const catalog = () =>
  serializeWorkflowCatalog({
    workflows: Fulfillment.workflows.map(({ workflow }) => workflow),
    tasks: Fulfillment.tasks.map(({ task }) => task),
  })

export const run = (id: string) => client.getDetail(id)
```

```ts
// Browser: types only, erased at build. Values arrive as JSON.
import type { WorkflowGraph } from '@nmtjs/workflows/inspector'
import type { RunDetail } from '@nmtjs/workflows/runtime'
```

`serializeWorkflowGraph(Fulfillment.contract)` is this JSON:

```json
{
  "name": "fulfillment",
  "nodes": [
    {
      "name": "checks",
      "kind": "parallel",
      "cases": [
        { "key": "units", "kind": "activity" },
        {
          "key": "risk",
          "kind": "task",
          "target": { "kind": "task", "name": "fulfillment.screen" }
        }
      ]
    },
    {
      "name": "reserve",
      "kind": "mapTask",
      "target": { "kind": "task", "name": "fulfillment.reserve" }
    },
    {
      "name": "ship",
      "kind": "mapWorkflow",
      "target": { "kind": "workflow", "name": "fulfillment.ship" }
    },
    {
      "name": "wrap",
      "kind": "branch",
      "cases": [
        { "key": "gift", "kind": "activity" },
        { "key": "plain", "kind": "activity" }
      ]
    }
  ]
}
```

It is the static graph: every alternative and every template, before any run.

| In the graph                            | In one run (`RunDetail`)                                        |
| --------------------------------------- | --------------------------------------------------------------- |
| a `branch` with all of its `cases`      | the node's `selectedCase`, and one child `case:<key>`           |
| a `parallel` with all of its `cases`    | one child per member, `member:<key>`, each with its status      |
| one `mapTask` / `mapWorkflow` node      | one child per item, `item:<index>`, each with its own child run |
| an `activity`, or a `task` / `workflow` | one child, `$self`, with its attempts or its child run          |
| a `target` naming a child workflow      | `childRuns`; that workflow's own graph is fetched by its name   |

A UI draws the graph, then overlays the run: `nodes` by `name`, and `children`,
`attempts` and `childRuns` by `nodeName`. `nodeUnits(detail, nodeName)` from the
inspector does that join for one node and works on the parsed JSON. It returns
parallel members ordered by key, so take their display order from the graph's
`cases`.

What the graph leaves out, as it does for hand-written contracts:

- Schemas, policies and concurrency. They are on the contract, not in the
  graph: a server that wants them in its payload adds them, for example
  `toStoredJsonSchema(Fulfillment.contract.input)` from `@nmtjs/workflows`.
- The steps of child workflows. `fulfillment.ship` is one `target`; its `label`
  activity is in `serializeWorkflowGraph(Ship.contract)`, or in the catalog.
- Anything about a past version. No graph is stored with a run, and this module
  does not add one: a run started before a deploy is drawn against the graph
  the server serializes now. Snapshotting graphs per run is a separate question
  this module leaves untouched.

## Running it

Nothing here is specific to this module: use the existing clients and Effect
workers. With the in-memory runtime:

```ts
import { runExecutionWorker, runWorkflowWorker } from '@nmtjs/workflows/effect'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  isTerminalRunStatus,
} from '@nmtjs/workflows/runtime'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

const runtime = createInMemoryWorkflowRuntime()
const client = createWorkflowRuntimeClient(runtime)
const worker = {
  ...runtime,
  // Required by the types: ChargeCard's handler uses Payments.
  context: Context.make(Payments, {
    charge: (invoice, cents) => Effect.succeed(`card:${invoice}:${cents}`),
  }),
  workflows: Billing.workflows,
  tasks: Billing.tasks,
  workerId: 'local',
}

const run = await client.start(Billing.contract, {
  id: 'o-1',
  mode: 'manual',
  cents: 1250,
})

// Each call drains what is queued; a deployment uses serve*Worker instead.
let snapshot = await client.get(run.id)
while (snapshot && !isTerminalRunStatus(snapshot.run.status)) {
  await runWorkflowWorker(worker)
  await runExecutionWorker(worker)
  snapshot = await client.get(run.id)
}

snapshot?.run.output
// manual:    { order: 'o-1', invoice: 'inv-o-1', paidBy: 'finance' }
// automatic: { order: 'o-1', invoice: 'inv-o-1', paidBy: 'card:inv-o-1:1250' }
```

For Neem, pass the same two lists to the existing worker definition:
`defineWorkflowsWorker({ workflows: () => Billing.workflows, tasks: () =>
Billing.tasks, layer, runtime })` from `@nmtjs/workflows/effect/neem`. Its
types require `layer` to provide `Payments`. Pools named by tasks and workflows
(`billing` and `payments` above) are declared in the Neem plan as for any other
implementation. Only the types of this call are tested here, not a Neem boot.

## Semantics

### Build time and run time

| When                         | What runs                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `task(...)` is called        | nothing of yours                                                                 |
| `workflow(...)` is called    | the generator body, once, start to end; the `cases` and `members` callbacks      |
| a coordinator advances a run | `select`, `from`, `items`, deferred inputs and the deferred result, when reached |
| an execution worker runs     | task and activity handlers, as Effects with the worker's services                |

The body is ordinary JavaScript and runs like any other code at module load.
Nothing sandboxes it: a statement that performs I/O performs it during the
build. Keep the body to step declarations.

### References and `read`

`yield*` returns a `Ref<Output>`, and `w.input` is a `Ref<Input>`. A reference
holds no value and is never a stand-in for one: there is nothing to read from
it while the workflow is being built, because no run exists yet.

A step's `input`, an activity's `from`, a map's `items` and the workflow's
result are each either

- a reference, passing that value through as is, or
- a deferred callback `(read) => value`, where `read(ref)` returns the decoded
  output the run produced for that reference.

`select` is always a deferred callback, and so is a map's `input`, which also
receives the item and its index. Deferred callbacks run in the coordinator,
where the existing API's input mappers, selectors and `finish` run, under the
same rules: keep them pure. The engine stores a selected case, a step's input
and a map's items, as it does for hand-written workflows.

A callback reads only what exists when its step starts: the workflow input and
the outputs of earlier steps. That holds for every member of a parallel and
every item of a map, however late the engine starts it.

### Do not branch on a reference

```ts
const invoice = yield* w.task('invoice', CreateInvoice, { input: w.input })
if (invoice) { ... } // always true: a Ref is an object
```

TypeScript cannot reject this, and it would describe a different graph per
build rather than a decision per run. Property access such as `invoice.cents`
is a type error. A decision that depends on a run's values is a `w.branch`,
whose cases are all declared and whose `select` picks one per run.

### Plans

Every `w.*` call returns a detached **plan**. Creating one adds nothing to the
workflow. `yield*` places it as the next step and returns its reference.

The `p` passed to `cases` and `members` builds **case plans**, a different
type: they carry no step name, they are not iterable, and they never join the
workflow's sequence. Only the selected case of a placed branch runs; every
member of a placed parallel does. A case plan has no reference, so members
cannot read one another, and no identity of its own, so one may be used under
several keys.

### Activities

An activity is a step declared where it is used: its schemas, the value it
receives, its handler and its policies are one object in the generator, and
nothing else names it. It has no pool option. It runs on the execution workers
of its workflow's `pool`, like the activities of a hand-written
implementation; a step that needs its own pool is a `task`.

The handler is an Effect handler, `(input, { signal }) => Effect`, and receives
the decoded value of `from`. `retry` and `timeout` are the activity's own;
there is no task default behind them. An activity that never declares `retry`
runs once.

### Parallel

Every member is started when the run reaches the step, each as its own engine
child: an activity attempt, a task run or a child workflow run. Nothing is
awaited in JavaScript, and there is no `Promise.all`: the coordinator parks the
run and resumes when a member settles.

The step completes when every member has, and its reference then holds
`{ [key]: output }`. If a member fails, its siblings are not cancelled: the
step fails once all of them have settled, with the first failure in member
order, and later steps do not run. A manual retry (`client.retry(runId)`) runs
the failed members again and keeps the completed ones' outputs.

### Maps

`items` is resolved once, when the run reaches the step, and the engine stores
the list encoded with `item`. `input` is called once per item, when the engine
starts that item, with the item decoded and its index.

- An empty list completes the step with `{ items: [] }`; `input` is never
  called, and later steps run.
- `concurrency` bounds how many items are running at once. Without it every
  item is started together. It must be a positive integer.
- `items` in the output are in item order, whatever order they finished in.
  Each entry is `{ item, index, runId, output }`.
- `retry` and `timeout` on `mapTask` apply to every item in place of the task's
  own; `cancellation` on `mapWorkflow` applies to every child run.
- A failed item does not stop the others. The step fails once every item has
  settled. A manual retry runs only the failed items again, in the same runs
  and under the same `concurrency`, without calling `items` again.

### Multi-step cases

The engine's branch cases and parallel members are single activities, tasks or
child workflows, so one with several steps is a workflow: declare it with `workflow(...)`, inline or as a
constant, and use `p.workflow(Child, { input })`. It runs as a child run with
its own name and its own input. It has its own references too: a parent's
reference cannot be read inside it, so pass what it needs through `input`.

### What is rejected, and when

While `workflow(...)` builds:

| Mistake                                                   | Error                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| a step name used twice, `input`, or an invalid identifier | the existing contract builder's error                          |
| a reserved case key such as `constructor`                 | the existing contract builder's error                          |
| a plan yielded twice                                      | `Plan [...] was already yielded`                               |
| a plan created and never yielded (a missing `yield*`)     | `Workflow [...] never yielded its plans: ...`                  |
| `yield plan` without `*`                                  | `Plan [...] must be yielded with yield*`                       |
| anything else yielded, such as an Effect                  | `Workflow [...] can only yield plans created by its builder`   |
| another workflow's plan yielded                           | `Plan [...] belongs to another workflow ...`                   |
| another workflow's reference as an `input` or the result  | `Reference [...] belongs to another workflow ...`              |
| a step plan used as a branch case                         | `Branch case [...] must be built with the cases builder`       |
| a step plan used as a parallel member                     | `Parallel member [...] must be built with the members builder` |
| a reserved member key such as `constructor`               | the existing contract builder's error                          |
| a missing `input`, `from`, `items` or result              | `[...] needs a reference or a deferred callback`               |
| an activity without a handler                             | `Missing activity handler [...]`                               |
| a map without its per-item `input` callback               | `[...] needs an input callback for its items`                  |
| a map `concurrency` that is not a positive integer        | the existing contract builder's error                          |

A deferred callback is not called during the build, so what it reads is checked
when it runs. `read` then throws for a reference of another workflow, or of a
step that comes later, instead of returning `undefined`; the engine fails the
run with that error, as it does for any throwing mapper or selector. In a map's
`input` the engine fails that item, lets the others settle, and then fails the
run.

### Types

- A handler's parameter and result come from the task's schemas.
- A step's `input` must be a `Ref` or deferred callback of the target's input
  type; the workflow's result likewise for its `output` schema.
- `select` must return one of the keys of `cases`; the branch's reference is
  the union of its cases' outputs.
- An activity's handler parameter and result come from its `input` and `output`
  schemas, and `from` must produce the `input` type.
- A parallel's reference is an object with one property per member. A member
  is not a reference, so it cannot be another member's `input`.
- A map's `items` must be a list of the `item` schema's type, and its `input`
  callback receives that type and must return the target's input.
- `tasks` keeps each task's handler requirements, so the Effect workers reject
  a `context` or `layer` that does not provide them.
- `implementation` carries the services of the workflow's own activities,
  whether they are steps, branch cases or parallel members, as
  `implementWorkflow` from `@nmtjs/workflows/effect` does. `workflows` keeps
  each implementation's own type, so a worker given a parent's `workflows` must
  also provide what a child workflow's activities require, however deep. A
  workflow without activities requires nothing.

## Ownership

| Concern                                                           | Owner                                            |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| names, case keys, schema-to-codec conversion, the contract itself | `../effect/contract.ts`, `../contract`           |
| task implementation and running handlers as Effects               | `../effect/implement.ts`, `../effect/handler.ts` |
| dispatch, retries, timeouts, cancellation, persistence, fencing   | the engine, stores and adapters, untouched       |
| the step list, references, `read`, the checks above               | this module                                      |

One part is not delegated. The existing `implementWorkflow` chain exposes one
typed method per literal node name, so it cannot be driven from a list of
steps. This module assembles the same `WorkflowImplementation` value directly
from the exported node types, wrapping activity handlers with the adapter
`implementWorkflow` uses. Tests build the same graphs with the existing
builders and compare contracts, serialized graphs and implementation nodes, so
a change to their shape fails here.

Step policies go where the engine reads them: `retry` and `timeout` on a task
step, case, member or map override the task's own, an activity's are its own,
`concurrency` bounds a map, and `cancellation` applies to a child workflow, all
through the contract node. Task and workflow options (`retry`,
`timeout`, `tags`, `idempotency`, `unique`, `title`, `description`) are passed
to the existing `defineTask` and `defineWorkflow` unchanged.

## Not supported

- A convergence `output` schema on a branch, and per-step or per-item
  `idempotency` keys.
- Omitting a step's `input` or an activity's `from`. The existing API passes
  the workflow input when a mapper is omitted; here it is always written, as
  `{ input: w.input }`. A map's `input` is likewise always written, even when
  it returns the item.
- A pool for one activity, and an activity shared between workflows. An
  activity belongs to the step that declares it; share a `task` instead.
- Branches, parallels or maps nested in one another. The engine's cases,
  members and map targets are single activities, tasks or child workflows, and
  a map's target is a task or a child workflow, never an activity: nest by
  declaring a child workflow.
- A member reading another member, cancelling siblings when one fails, or
  completing a map before every item has settled.
- Loops whose count depends on a run, `if` on a run's values, and recovering
  from a failed step. The engine has no such nodes: a failed step fails the
  run.
- Standard Schema and Promise handlers. Schemas are `effect/Schema` and
  handlers return Effects, through `@nmtjs/workflows/effect`.
- Using an existing hand-written contract as a step target.
- Separating contracts from handlers for client-only imports.
- Any guarantee about code in the generator body other than step declarations.

## Validation

```sh
pnpm vitest run --reporter=agent \
  packages/workflows/tests/experimental-authoring.spec.ts \
  packages/workflows/tests/experimental-authoring-nodes.spec.ts \
  packages/workflows/tests/experimental-authoring-types.spec.ts \
  packages/workflows/tests/experimental-authoring-nodes-types.spec.ts
pnpm check:type
```

The first suite runs on the real in-memory engine with the real Effect workers:
no handler or callback runs during a build, both cases are in the graph, only
the selected case runs for each of two inputs, references and branch results
reach later steps, a child workflow's steps run in order, step retry overrides
apply, an exhausted step fails the run, and each misuse above is rejected.

The second does the same for activities, parallels and maps: the contract, the
serialized graph and the implementation nodes equal those of the existing
builders, only the selected activity case runs, a parallel aggregates its
members and settles all of them before failing, maps handle zero and several
items, hold to their `concurrency` and keep item order, a manual retry reruns
only a failed member or item, and both fulfillment outputs above are produced
with the worker's `Carriers`. It also checks the graph and run-state JSON of
[Showing a workflow in a frontend](#showing-a-workflow-in-a-frontend).

The two type suites hold the type-level cases as `@ts-expect-error` lines,
which `pnpm check:type` checks. PostgreSQL, Redis, restart recovery and a Neem
boot were not run for this module; manual retry was run on the in-memory
runtime only.
