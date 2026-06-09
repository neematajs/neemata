# Package Runtime Helpers

Package helpers adapt Neem's generic runtime primitives to package-owned
semantics. They expose public APIs for app runtime files, but their
implementation is package-authored code.

## Runtime Factory

Expose `create*Runtime()` only when the package contributes runtime declaration
defaults:

```ts
import { createRuntime } from '@nmtjs/neem'

export function createServiceRuntime() {
  return createRuntime({
    host: { entry: '@acme/service/neem/host' },
  })
}
```

The helper returns a Neem declaration helper. Apps usually name the returned
function `defineRuntime` locally:

```ts
import { createServiceRuntime } from '@acme/service/neem'

const defineRuntime = createServiceRuntime()

export default defineRuntime({
  name: 'service',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

Do not expose `create*Runtime()` when the package has no common declaration
defaults. Host-free runtimes with caller-owned worker entries should use raw
`defineRuntime(...)` in the app runtime declaration.

Package helpers must use entry specifiers for package-owned defaults:

```ts
// Good: package owns host entry specifier.
createRuntime({ host: { entry: '@acme/service/neem/host' } })
```

```ts
// Bad: package helper imports host implementation directly.
import host from './host.ts'
```

Specifiers preserve separate build artifacts and worker-thread isolation.

## Planner Helper

Planner helpers adapt package config to Neem topology:

```ts
import type { NeemRuntimePlanner, NeemRuntimePlannerContext } from '@nmtjs/neem'
import { defineRuntimePlanner } from '@nmtjs/neem'

export type ServicePlannerInput = {
  shards: number
}
export type ServiceWorkerData = { shard: number }
export type ServiceRuntimePlanner = NeemRuntimePlanner<undefined, ServiceWorkerData>

export function defineServicePlanner(
  input: ServicePlannerInput,
): ServiceRuntimePlanner {
  return defineRuntimePlanner<undefined, ServiceWorkerData>(
    async (ctx) => {
      ctx.logger.info({ runtime: ctx.name }, 'planning service runtime')

      return {
        workers: Array.from({ length: input.shards }, (_, shard) => ({
          shard,
        })),
      }
    },
  )
}
```

`Options` and `Data` are Neem boundary types, not prescribed package config
shapes. `Data` is worker `ctx.data`; `Options` is host `params.options`.
Packages decide their own planner input and optional host options. Prefer
`defineRuntimePlanner<Options, Data>(...)`; do not annotate callback returns
with low-level plan types.

## Worker Helper

Worker helpers adapt package config to a marked Neem worker entry:

```ts
import { defineRuntimeWorker } from '@nmtjs/neem'

export function defineServiceWorker(config: ServiceWorkerConfig) {
  return defineRuntimeWorker<ServiceWorkerData, ServiceWorkerConfig>({
    definition: config,
    createRuntime(ctx) {
      return new ServiceRuntime(ctx.data, ctx.definition, ctx.logger)
    },
  })
}
```

`ServiceWorkerData` must match planner worker items. `ServiceWorkerConfig` must
match the worker `definition`.

## Why

- App-owned entries (`name`, `planner`, `worker.entry`) belong in the app
  runtime declaration.
- Package-owned defaults (`host.entry`, worker build plugins) belong in
  package `create*Runtime()` helpers.
- Host-free runtimes with no common defaults should use core Neem
  `defineRuntime(...)` directly.
- Entry specifiers keep planner, host, and worker import graphs isolated for
  separate build artifacts and worker-thread execution.
- Fewer helper shapes means fewer APIs, clearer boundaries, and less magic.

## Boundaries

- Package helper owns package planner, worker, host, config, protocol, and
  defaults.
- Neem owns declaration branding, declaration-layer merging, build graph,
  artifacts, lifecycle, host/worker isolation, health, env, proxy, plugins, and
  runtime selection.
- Host/worker `MessagePort` protocol is package-owned. Neem only creates and
  transfers the ports.
- Package helpers may import shared pure types/helpers, but must not import
  marked planner/host/worker entry modules as values.
