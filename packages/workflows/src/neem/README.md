# Neem hosting

Runs the engine's workers as Neem worker threads: coordinators that advance
runs and do the engine's maintenance, and execution workers that run the
handlers of one pool each. It is glue over `@nmtjs/effect`, the Neem preset
for supervised Effect applications, which owns the lifetime of every thread.

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
// workflows.planner.ts: the main thread; it loads no application code.
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1, concurrency: 4, runTimeouts: { everyMs: 30_000 } },
  pools: {
    billing: { concurrency: 8 },
    payments: { threads: 2, cleanupTimeoutMs: 1_000 },
  },
}))
```

```ts
// workflows.worker.ts: every thread, whatever its role.
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem/worker'

export default defineWorkflowsWorker({
  workflows: [Billing, ManualBilling],
  tasks: [CreateInvoice, ChargeCard, RequestApproval, RecordPayment],
  schedules: [NightlyBilling],
  store: () => Postgres.layer().pipe(Layer.provide(database)),
  layer: (ctx) => Layer.succeed(Payments, payments(ctx.logger)),
})
```

Register `./workflows.runtime.ts` in Neem's `runtimes`.

## The plan

`coordinator` and every pool take `threads` (1 when omitted) and the options
of the worker they run: `concurrency`, `leaseMs` and `pollMs` for both,
`cleanupTimeoutMs` for a pool, and for the coordinator what
`Worker.coordinator` takes for its maintenance (`reaping`, `runTimeouts`,
`scheduling`, `retention`). They are handed to the workers as they are, so an
option the engine adds is an option of the plan.

A plan is copied to the threads as data, so it holds settings only. The
schedules are declarations and belong to the worker.

Neem names the threads `<runtime>:coordinator:<n>` and
`<runtime>:execution:<n>`, the pools in the order they are declared. Every pool
a declaration names must be declared; there is no default pool.

## The worker

`store` and `layer` are called with Neem's worker context each time a thread
starts, which a development reload does again in the same thread. `ctx.data`
names the role and the pool, `ctx.logger` is the worker's logger.

- `store` provides `Store` to the thread. Threads share runs only through a
  durable store: `InMemory.layer()` gives every thread a store of its own.
  Application code elsewhere reaches the same runs by providing the same
  layer to `Client`.
- `schedules` are the deployment's schedules, all of them. Every coordinator
  thread makes the stored schedules these as it starts, removing any other,
  and fires those that are due. Omitted, schedules are left alone.
- `layer` provides what the handlers require, and the type of the definition
  requires it to provide all of it: the services of every task handler and of
  every activity, whatever pool runs it. It may use the store, as handlers
  may. It is built only in the threads that run handlers.

A thread starts only if `Worker.verify` accepts what is served with the
planned pools and the schedules, and its options are valid; nothing is
acquired before that. A declaration listed twice counts once.

`Effect.log*` goes to `ctx.logger`: the engine's reports and the handlers' own
logs, annotations as fields and a cause as `err`.

## Stopping

Neem stops a thread, on shutdown and on a development reload, by interrupting
it: handlers are interrupted and their commands given back for another worker,
passes under way are finished, then the handler services are released, then
the store. Neem's stop deadline bounds all of it.

A handler that does not end within its pool's `cleanupTimeoutMs` fails the
thread with `CleanupTimeout`, so Neem replaces it. The store and the handler
services are not released then: the handler is still running and may still
use them. Its command is delivered again when its lease ends.
