# Package Runtime Helpers

Package helpers map application configuration to Neem's declaration, planner,
and worker contracts. Keep shared types/helpers separate from executable entry
modules, and keep package-owned entry defaults as published module specifiers.
Choose a helper's call shape deliberately: existing presets differ.

## Workflows: host preset and role-based planning

`@nmtjs/workflows/neem` exports `createWorkflowsRuntime`,
`defineWorkflowsPlanner`, `defineWorkflowsWorker`, and their public configuration
types. Its host entry is exported at `@nmtjs/workflows/neem/host`; the worker
helper also has the `@nmtjs/workflows/neem/worker-entry` subpath.

`createWorkflowsRuntime()` takes no arguments and returns
`createRuntime({ host: { entry: '@nmtjs/workflows/neem/host' } })`. The caller
supplies its name, planner, and worker to that returned declaration function:

```ts
import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

const defineRuntime = createWorkflowsRuntime()

export default defineRuntime({
  name: 'jobs',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
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

`defineWorkflowsPlanner(factory: () => MaybePromise<WorkflowsPlan>)` calls a
zero-argument factory, not a callback receiving Neem context. It runs in the
host runner, without loading application implementations. Its return is a
marked `NeemRuntimePlanner<ResolvedWorkflowsPlan, WorkflowsWorkerData>`;
`ResolvedWorkflowsPlan` is internal, not an export to import from `/neem`.

- `WorkflowsPlan` has optional `coordinator` and required named `pools`.
  At least one execution pool and nonempty pool names are required.
- `WorkflowsPoolConfig` is partial `WorkflowsWorkerSettings` plus optional
  `threads`. Defaults for coordinator and every pool: `threads: 1`,
  `concurrency: 1`, `leaseMs: 30_000`, `pollIntervalMs: 250`,
  `cleanupTimeoutMs: 5_000`. Threads must be a positive integer.
- The planner emits groups named `coordinator` and `execution`. Every worker
  gets `role`, resolved `settings`, and all declared `pools`; execution workers
  also get their `pool`. Pool names select handlers, not separate Neem worker
  artifacts. Planner `options` is the resolved plan.
- The host checks that options exist and logs the thread/pool layout. Worker
  loops perform coordination and execution; the host does not own their
  adapters or handler environment.

## Workflows: worker setup and resource ownership

`defineWorkflowsWorker<const W = never, const T = never>` constrains `W` and
`T` to workflow/task implementations and accepts
`WorkflowsWorkerDefinition<W, T>`. It creates a marked
`NeemRuntimeWorker<WorkflowsWorkerData, unknown>` whose definition is loaded
inside each thread.

The definition includes `WorkflowsRegistry`: required async-capable
`workflows()` and optional `tasks()` and `schedules()` array loaders. It also
requires `setup(ctx)`, run once per worker thread, with
`NeemRuntimeWorkerContext<WorkflowsWorkerData, unknown>`. `ctx.definition` is
therefore `unknown`; the helper closes over its typed definition.

`setup` returns `WorkflowsWorkerResources<E>` or a promise:

- Required `runtime: WorkflowRuntimeAdapter`.
- `env: E` for the Promise handlers. Its type is inferred from registered
  workflow/task implementations and is required when they require it; it is
  optional when their environment is `unknown`.
- Optional `dispose(): MaybePromise<void>` for resources owned by that env or
  setup. Open thread-local clients here. Workers needing shared durable state
  must connect to the same backing store; an in-memory adapter is local to one
  thread.

The helper resolves and validates the registry before setup: duplicate
implementation names, missing referenced children/tasks, schedule targets,
definition identity conflicts, and undeclared implementation pools fail
startup. Pool validation uses planner `data.pools`; manually supplied worker
data without that field skips this check.

After setup, coordinator workers reconcile schedules (requiring adapter
scheduler support), then start their role loop. `start()` resolves `undefined`
when serving; `finished` reports a loop ending unexpectedly. Shutdown aborts
claims/attempts, joins loop work, drains handlers, then calls
`runtime.dispose?.()` followed by resource `dispose?.()`, even if adapter
disposal throws. Setup must clean up its own acquisitions if it rejects before
returning resources. A stop during setup waits for its returned resources and
cleans them up.

`cleanupTimeoutMs` sets the package's cleanup failure deadline and can signal
fatal failure while running. It cannot extend Neem's hard 5,000 ms worker stop
deadline. Keep the package deadline and the outer thread deadline distinct.

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
supervised. The preset pins its `effect` peer to `4.0.0-rc.116` and does not
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
