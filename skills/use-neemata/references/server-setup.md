# Application Setup

Application code is pure Neemata. Runtime/process orchestration belongs to Neem
runtime files.

## Application And Host

```ts
import { app, eventingPlugin, host, pubsubPlugin } from 'nmtjs'
import { HttpTransport } from '@nmtjs/http-transport/node'

import { api } from './router.ts'

export const application = app({
  router: api,
  plugins: [
    eventingPlugin({ adapter: () => createEventingAdapter() }),
    pubsubPlugin({ adapter: createPubSubAdapter() }),
  ],
})

export default host(application, {
  transports: { http: HttpTransport },
})
```

Rules:

- `app(...)` defines router, guards, middleware, filters, hooks, plugins, and
  metadata. It should not own listen ports or runtime thread counts.
- `host(app, { transports })` binds the app to transport factories.
- Transport packages stay direct imports because they are separate runtime
  dependencies.
- App-level static metadata merges with router and procedure metadata.

## Neemata Runtime Files

Package runtime helper imports stay on `@nmtjs/application/neem/*` subpaths.
Generic shape:

```ts
// neem.runtime.ts
import { createNeemataRuntime } from '@nmtjs/application/neem/runtime'

const defineRuntime = createNeemataRuntime()

export default defineRuntime({
  name: 'neemata',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

```ts
// neem.planner.ts
import { defineNeemataPlanner } from '@nmtjs/application/neem/planner'

export default defineNeemataPlanner(() => ({
  instances: 2,
  transports: {
    http: { listen: { hostname: '127.0.0.1', port: 0 } },
  },
}))
```

```ts
// neem.worker.ts
import { defineNeemataWorker } from '@nmtjs/application/neem/worker'

import applicationHost from './api.ts'

export default defineNeemataWorker(applicationHost)
```

The app runtime worker entry loads application host code and runs worker-side
Neemata runtime logic.

## Project Shape

```text
src/runtimes/neemata/
  api.ts            # app(...) and host(...)
  router.ts         # rootRouter(...)
  procedures/*.ts
  neem.runtime.ts   # createNeemataRuntime(...) helper, then export declaration
  neem.planner.ts   # defineNeemataPlanner(...)
  neem.worker.ts    # defineNeemataWorker(...)
```

Keep contracts in shared packages when clients import the same public API shape.
