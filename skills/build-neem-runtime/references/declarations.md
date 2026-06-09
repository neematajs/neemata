# Runtime Declarations

Runtime declaration files are the build-time entrypoint for one named runtime.
They default-export a marked declaration from `defineRuntime(...)` or a package
helper built on `createRuntime(...)`.

## Raw Declaration

Use raw `defineRuntime(...)` for a custom runtime or for tests of the generic
Neem contract:

```ts
import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'custom',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
  host: { entry: './neem.host.ts' },
  env: { FEATURE_FLAG: '1' },
})
```

Rules:

- `planner`, `worker.entry`, and `host.entry` are module specifiers resolved from
  the runtime declaration file.
- Keep entries as import specifiers, not imported values. Neem builds planner,
  host, and worker as separate artifacts with separate import graphs.
- A planner is required. If omitted in the declaration, Neem looks for a
  conventional `neem.planner.ts`, `.mts`, `.js`, or `.mjs` next to the
  declaration file.
- Runtime name comes from explicit `name` or nearest `package.json#name`.
- `host + worker`, `host only` with `host.entry`, and `worker only` are valid.
  `no host + no worker` is invalid.
- `env` objects are frozen and merged between declaration layers.
- Build options are artifact concerns, not runtime behavior.
- Declaration files should not create runtime resources.

## Import Boundary

Runtime declarations describe entrypoints; they do not compose the runtime by
importing planner, host, or worker implementations directly.

```ts
// Good: entry specifiers preserve artifact/thread isolation.
export default defineRuntime({
  name: 'service',
  planner: './neem.planner.ts',
  host: { entry: './neem.host.ts' },
  worker: { entry: './neem.worker.ts' },
})
```

```ts
// Bad: direct imports collapse separate runtime graphs into this module.
import host from './neem.host.ts'
import planner from './neem.planner.ts'
import worker from './neem.worker.ts'
```

Why:

- Planner and host run in the host-runner worker thread.
- Worker entry runs in runtime worker threads.
- Each entry becomes its own build artifact and bundle graph.
- Direct imports pull code into the wrong artifact and can start resources in
  the wrong process.
- Specifiers let Neem rebuild/reload planner, host, and worker artifacts
  independently.

## Runtime Factory Helper

Expose a `create*Runtime()` helper only when the package contributes runtime
declaration defaults. Good defaults are package-owned `host.entry` values,
worker build plugins, or other package-owned artifact settings.

```ts
import { createRuntime } from '@nmtjs/neem'

export function createServiceRuntime() {
  return createRuntime({
    host: { entry: '@acme/service/neem/host' },
  })
}
```

The app calls the returned helper and supplies app-owned entries:

```ts
const defineRuntime = createServiceRuntime()

export default defineRuntime({
  name: 'service',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

Rules:

- `createRuntime(...)` returns a declaration helper. The returned helper merges
  common and user declaration layers, freezes merged `env`, and brands the final
  declaration for Neem validation.
- App-owned entries (`name`, `planner`, `worker.entry`) belong in app runtime
  declarations.
- Package-owned defaults (`host.entry`, build plugins) belong in
  `create*Runtime()`.
- Package helpers should provide package-owned entry specifiers, not imported
  host/worker/planner functions.
- If the package contributes no declaration defaults, do not create a runtime
  helper. Use raw `defineRuntime(...)` in the app declaration.

## Discovery Contract

Neem project config resolves runtime declarations from `runtimes` entries:
files, folders, globs, and negated globs.

Runtime declaration files must default-export a marked declaration. Plain
objects/functions fail validation with an error pointing at the declaration
file.
