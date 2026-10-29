# Package Runtime Helpers

Package helpers map application configuration to Neem's declaration, planner,
and worker contracts. Keep shared types/helpers separate from executable entry
modules, and keep package-owned entry defaults as published module specifiers.
Choose a helper's call shape deliberately: both presets below are
declaration functions made by `createRuntime`; a helper that needs arguments
can instead be a factory returning one.

## Workflows: role-based planning over the Effect worker preset

`@nmtjs/workflows/neem` exports `createWorkflowsRuntime`,
`defineWorkflowsPlanner` and the plan types (`WorkflowsPlan`,
`CoordinatorPlan`, `PoolPlan`, `WorkerData`). The worker helper is a
separate entry, `@nmtjs/workflows/neem/worker`, so that a planner loads no
Effect runtime. There is no host entry: the runtime uses Neem's default host.

`createWorkflowsRuntime` is `createRuntime({})`: a declaration function that
takes the declaration directly, with no package defaults:

```ts
import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

export default createWorkflowsRuntime({
  name: 'jobs',
  planner: './workflows.planner.ts',
  worker: { entry: './workflows.worker.ts' },
})
```

The planner module can default-export this:

```ts
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { threads: 1 },
  pools: {
    default: { threads: 2, concurrency: 4 },
    slow: { threads: 1, concurrency: 1 },
  },
}))
```

`defineWorkflowsPlanner(factory: () => WorkflowsPlan | Promise<WorkflowsPlan>)`
calls a zero-argument factory, not a callback receiving Neem context. It runs
in the host runner, without loading application declarations, and returns
`defineRuntimePlanner<undefined, WorkerData>(...)`.

- `WorkflowsPlan` has optional `coordinator` and required named `pools`. At
  least one pool and nonempty pool names are required; a `schedules` field on
  the coordinator is rejected, since schedules are worker declarations.
- `CoordinatorPlan` / `PoolPlan` are `threads` (1, a positive integer) plus
  the engine worker's options, passed through unvalidated: each worker checks
  its own options when it starts. Defaults are the engine's.
- The planner emits groups `coordinator` and `execution`, one data entry per
  thread. Every entry carries `role`, `options` and all planned `pools`;
  execution entries also carry their `pool`. Pool names select which handlers
  a thread runs, not separate Neem worker artifacts.
- Name is the trimmed explicit `name`, otherwise the nearest nonempty
  `package.json#name` walking upward. Duplicate names fail resolution.
- Project `runtimes` entries are files, directories, globs, or negated globs
  relative to the config file. Directories use `neem.runtime.ts`, `.mts`,
  `.js`, `.mjs` in that order. Positive entries matching nothing fail.

## Workflows: worker definition and resource ownership

`defineWorkflowsWorker<const W = never, const T = never>(definition)` takes
`{ workflows?, tasks?, schedules?, store, layer? }` and returns
`defineEffectWorker(...)` from `@nmtjs/effect/neem/worker`, so it is a marked
`NeemRuntimeWorker<WorkerData, undefined>` loaded inside each thread.

- `store: (ctx) => Layer<Store, unknown>` and
  `layer: (ctx) => Layer<Services, unknown, Store>` are called with
  `NeemRuntimeWorkerContext<WorkerData, undefined>` on every thread start,
  including dev reloads. `layer`'s type must provide the services of every
  task and activity handler in the definition; it is optional only when there
  are none, and is built only in execution threads.
- Before acquiring anything, the thread deduplicates declarations and runs
  `Worker.verify` with the planned `pools` and the schedules: missing child
  workflows, tasks or schedule targets, conflicting declarations of one name
  and revision, and undeclared pools fail startup. Worker data without a
  `role` (no workflows planner) is rejected.
- A coordinator thread runs `Worker.coordinator` with the plan's options and
  the schedules; an execution thread runs `Worker.execution` for its pool. A
  coordinator never builds `layer`.
- `Effect.log*` is routed to `ctx.logger` around everything the thread runs,
  layer construction included.
- Stop interrupts the worker: handlers are interrupted and their commands
  given back, then handler services and the store are released in a scope
  the helper owns. When the worker fails with `CleanupTimeout`, those layers
  are deliberately not released, because a handler still running may use
  them; the thread fails and Neem replaces it.

`cleanupTimeoutMs` sets the engine's per-handler cleanup deadline. It cannot
extend Neem's hard 5,000 ms worker stop deadline. Keep the package deadline
and the outer thread deadline distinct.

## Effect: a declaration function and supervised application

`createEffectRuntime` from `@nmtjs/effect` is already the declaration function
returned by `createRuntime({ planner: '@nmtjs/effect/neem/planner' })`.
Pass declaration options directly; do not call it with no arguments first.

```ts
import { createEffectRuntime } from '@nmtjs/effect'

export default createEffectRuntime({
  name: 'service',
  worker: { entry: './neem.worker.ts' },
})
```

The default planner is a marked planner returning `workers: [{}]`, with no
host options. A user planner overrides it through declaration layering. The
preset supplies no custom host, application worker, or transports; a default
planner is itself a useful declaration default even for a host-free package.

`@nmtjs/effect/neem/worker` exports `defineEffectWorker`, `EffectApplication`,
and `Ready`. `defineEffectWorker<R, EL, EM, Data = unknown>(create)` accepts a
synchronous callback from `NeemRuntimeWorkerContext<Data, undefined>` to
`EffectApplication<R, EL, EM>`, returning
`NeemRuntimeWorker<Data, undefined>`:

- `layer: Layer.Layer<R, EL>` supplies the application services and must have
  its own dependencies provided.
- `main(ready): Effect.Effect<unknown, EM, NoInfer<R> | Scope.Scope>` runs the
  long-lived application. Acquire resources through the Layer or scoped main,
  not eagerly in `create`.
- `Ready` is `(upstreams?: readonly NeemRuntimeUpstream[]) => Effect.Effect<void>`.
  Execute this effect only after listeners/resources are ready. Omitted
  upstreams mean `[]`. Then keep main alive; successful completion before a
  requested stop is also failure.

```ts
import { defineEffectWorker } from '@nmtjs/effect/neem/worker'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

export default defineEffectWorker(() => ({
  layer: Layer.empty,
  main: (ready) =>
    Effect.gen(function* () {
      yield* ready()
      yield* Effect.never
    }),
}))
```

One supervised fiber owns the scoped main and provided Layer. `stop()`
interrupts and joins it, including finalizers; `finished` reflects its exit.
Pre-readiness failure rejects start; post-readiness failure reaches Neem via
`finished`. Background work must be composed into main or explicitly
supervised. The preset requires the `effect@^4.1.0` peer and does not
bridge Effect logging into `ctx.logger` automatically.

## Applying these patterns

Keep planner data cloneable and free of clients/functions. Keep worker
configuration, implementation loaders, and resource acquisition worker-local.
Use `NeemRuntimePlanner<Options, Data>` and
`defineRuntimePlanner<Options, Data>` for custom planners; keep the host's
options and worker's data types aligned with that plan. Use
`defineRuntimeWorker<Data, Definition>` for package-owned definitions.

A package helper may supply planner, host, worker, or build defaults when it
owns them; application-specific choices remain with the application. Use raw
`defineRuntime` when no package defaults are needed. Neem owns declaration
merging, build targets, thread lifecycle, env, health, proxy, and hooks; the
package owns its application protocol and resource cleanup.
