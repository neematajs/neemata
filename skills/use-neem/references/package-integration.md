# Package Integration

End-user Neem projects should normally declare runtimes with package-owned
helpers only when the package contributes runtime declaration defaults. A
package helper owns package-provided host entries, worker build defaults, and
runtime protocol conventions; app-owned `name`, `planner`, and `worker.entry`
stay in the app runtime declaration. Neem owns discovery, artifact building,
lifecycle, proxy, health, env, plugins, and runtime selection.

Examples below use package runtime helper shape, not a specific repository
layout. Keep application code on the package's public end-user import surface
when one exists.

## Project Config

```ts
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  proxy: {
    hostname: '127.0.0.1',
    port: 3000,
    runtimes: {
      api: { routing: { default: true } },
    },
  },
  runtimes: ['./src/runtimes/*'],
})
```

Use explicit files when the project needs exact ordering or narrow selection:

```ts
runtimes: [
  './src/runtimes/api/neem.runtime.ts',
  './src/runtimes/jobs/neem.runtime.ts',
  './src/runtimes/events/neem.runtime.ts',
  './src/runtimes/scheduler/neem.runtime.ts',
]
```

Use globs and negated globs for discovery:

```ts
runtimes: [
  './src/runtimes/**/neem.runtime.ts',
  '!./src/runtimes/experimental/**',
]
```

## Jobs Runtime

```ts
import { createJobsRuntime } from '@nmtjs/jobs/neem'

const defineRuntime = createJobsRuntime()

export default defineRuntime({
  name: 'jobs',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

Planner and worker use helpers from the same package:

```ts
// neem.planner.ts
import { defineJobsPlanner } from '@nmtjs/jobs/neem'

export default defineJobsPlanner(() => jobsConfig)
```

```ts
// neem.worker.ts
import { defineJobsWorker } from '@nmtjs/jobs/neem'

export default defineJobsWorker(jobsConfig)
```

## Eventing Runtime

Eventing has no package-owned host entry or worker build defaults, so plain
Neem `defineRuntime(...)` is the runtime declaration helper:

```ts
import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'events',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

## Scheduler Runtime

Scheduler is host-only and owns its host entry:

```ts
import { createSchedulerRuntime } from '@nmtjs/scheduler/neem'

const defineRuntime = createSchedulerRuntime()

export default defineRuntime({
  name: 'scheduler',
  planner: './neem.planner.ts',
})
```

## Metrics Plugin

Metrics is a package-owned Neem plugin, not a runtime helper:

```ts
import metrics from '@nmtjs/metrics/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  plugins: [
    metrics({
      server: { host: '127.0.0.1', port: 9187, path: '/metrics' },
    }),
  ],
  runtimes: ['./src/runtimes/**/neem.runtime.ts'],
})
```

Use this shape when a package contributes Neem controller behavior such as
health/lifecycle observation or a controller-owned HTTP endpoint. Do not invent
a metrics runtime declaration.

## Rules

- Package helpers own package-specific host/worker/planner conventions.
- Neem owns generic declaration shape, artifact building, lifecycle, health,
  proxy, env, and runtime selection.
- Controller plugins belong in `plugins`; runtime declarations belong in
  `runtimes`.
- Use `create*Runtime()` helpers only when the package contributes runtime
  declaration defaults, such as `host.entry` or worker build plugins.
- Use raw `defineRuntime(...)` when the app owns the whole runtime declaration
  and the package has no common runtime defaults.
- Use `build-neem-runtime` only when authoring a custom runtime or reusable
  package helper.
