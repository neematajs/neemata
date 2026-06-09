# Runtimes

`@nmtjs/neem` project config declares which runtime projects exist and how Neem
orchestrates them. It is generic: application, jobs, eventing, scheduler,
metrics, bots, and custom services are all named runtimes.

## Project Config

```ts
import { metrics } from '@nmtjs/metrics/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: { pinoOptions: { level: 'info' } },
  env: { NODE_ENV: 'production' },
  plugins: [
    metrics({
      server: { host: '127.0.0.1', port: 9187, path: '/metrics' },
    }),
  ],
  proxy: {
    hostname: '127.0.0.1',
    port: 3000,
    runtimes: {
      api: { routing: { default: true } },
    },
  },
  runtimes: [
    './src/runtimes/**/neem.runtime.ts',
    '!./src/runtimes/experimental/**',
  ],
})
```

Rules:

- `runtimes` is an array of file paths, folder paths, globs, or negated globs.
  Relative entries resolve from the `neem.config.ts` directory.
- Folder entries resolve conventional runtime declaration files:
  `neem.runtime.ts`, `.mts`, `.js`, or `.mjs`.
- Positive entries that match nothing fail. Negated entries only remove matches.
- Runtime declaration files default-export a branded declaration from a package
  helper or raw `defineRuntime(...)` for custom runtimes.
- Runtime names come from explicit `name` or nearest `package.json#name`.
  Duplicate names fail.
- Config is declarative. Do not open Redis clients, sockets, log transports, or
  runtime resources in `neem.config.ts`.
- Production `start` reads built manifest/artifacts, not source config.

## Runtime Declaration Files

End-user projects should default-export declarations produced by package
helpers when a package contributes runtime defaults:

```ts
import { createJobsRuntime } from '@nmtjs/jobs/neem'

const defineRuntime = createJobsRuntime()

export default defineRuntime({
  name: 'jobs',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
})
```

Rules:

- A runtime declaration file is the boundary between project config and package
  runtime implementation.
- App-owned entries such as `name`, `planner`, and `worker.entry` stay in the
  runtime declaration.
- Package-owned defaults such as `host.entry` or worker build plugins belong in
  package `create*Runtime()` helpers.
- Host-free runtimes with no common defaults should use raw `defineRuntime(...)`.
- `planner`, `host.entry`, and `worker.entry` are import specifiers. Do not
  direct-import planner, host, or worker modules into the declaration file.
  Neem builds them as separate artifacts and runs them in separate
  host-runner/worker-thread contexts.
- Keep runtime resource creation in runtime entry files, not declaration files.
- Raw `defineRuntime(...)`, `createRuntime(...)`, `defineRuntimeHost(...)`,
  `defineRuntimeWorker(...)`, and `defineRuntimePlanner(...)` are runtime-author
  APIs; use `build-neem-runtime` skill for those.
