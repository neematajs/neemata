# NeemataJS

Neem hosting and durable workflows. Applications own their RPC, HTTP and clients;
Neemata supervises their processes and coordinates their durable work.

| Package            | Purpose                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `@nmtjs/neem`      | Runtime host and CLI: planners, workers, proxy, health, plugins ([README](packages/neem/README.md))    |
| `@nmtjs/workflows` | Typed tasks and workflow graphs with a PostgreSQL runtime ([README](packages/workflows/README.md))     |
| `@nmtjs/pubsub`    | Typed ephemeral publish/subscribe with Redis and Valkey adapters ([README](packages/pubsub/README.md)) |
| `@nmtjs/effect`    | Neem worker preset for a supervised Effect application ([README](packages/effect/README.md))           |
| `@nmtjs/metrics`   | Metrics plugin for a Neem project                                                                      |
| `@nmtjs/vite`      | Neem runtime for a Vite application                                                                    |
| `@nmtjs/nuxt`      | Neem runtime for a Nuxt application                                                                    |
| `@nmtjs/common`    | Utilities shared by the packages above                                                                 |

The workflows core has no Effect dependency: definitions take Standard Schemas and
handlers return values or Promises. `@nmtjs/workflows/effect` and `@nmtjs/effect`
require **Effect 4.0.0-rc.116**, pinned exactly. See the
[migration plan](docs/effect-migration-plan.md) for the design record and
[todo](docs/todo.md) for deferred work.

## Workflows with typed steps

Task contracts and workflow graphs are separate from their implementations. Named
steps expose typed outputs to subsequent input mappings, and every task and workflow
names the execution pool it runs on:

```ts
// workflow.ts
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'
import * as z from 'zod'

const normalize = defineTask({
  name: 'normalize',
  input: z.string(),
  output: z.string(),
})

export const normalizeTask = implementTask(normalize, {
  pool: 'default',
  handler: (text) => text.trim().toLowerCase(),
})

export const wordCount = defineWorkflow({
  name: 'word-count',
  input: z.string(),
  output: z.number(),
})
  .task('normalized', normalize)
  .activity('counted', { input: z.string(), output: z.number() })
  .build()

export const wordCountWorkflow = implementWorkflow(wordCount, {
  pool: 'default',
})
  .normalized(normalize, { input: (_outputs, input) => input })
  .counted((text) => (text ? text.split(/\s+/).length : 0), {
    input: (outputs) => outputs.normalized,
  })
  .finish((outputs) => outputs.counted)
```

Graphs also support branches, parallel steps, nested workflows, and bounded fan-out
with `mapTask` / `mapWorkflow`. The PostgreSQL runtime persists progress and supports
retrying failed work while retaining successful nodes.

## Neem CLI

`neem build` compiles config, app entries, plugin entries, and plugin-declared
artifacts into `dist` by default. It writes an internal `neem.manifest.json`
with relative artifact paths.

`neem start` consumes an existing built output directory. It reads the manifest
for executable artifacts and serialized runtime config, registers built plugin
hooks, and starts app workers in production mode.

`neem dev` uses `.neem` by default as a build-like watched output directory. It
uses the same manifest shape as `start`, restarts app workers after successful
config/app rebuilds, reloads plugin hooks after plugin entry rebuilds, and keeps
existing workers alive on rebuild errors.

Use `neem dev --env-files ../../.env` to load environment variables before config
evaluation and worker startup. See [development environment files](packages/neem/README.md)
for precedence and multiple-file usage.

## Service integration tests

Service-backed integration tests live beside package owners under
`packages/*/tests/integration`.

```sh
docker compose up -d --wait redis valkey postgres
NMTJS_REQUIRE_SERVICE_TESTS=1 \
REDIS_URL=redis://localhost:6379 \
VALKEY_URL=redis://localhost:6380 \
POSTGRES_URL=postgres://neemata:neemata@localhost:5432/neemata \
pnpm run test:integration:services
```

Without service env, these tests skip in normal package/root test runs. In CI,
`NMTJS_REQUIRE_SERVICE_TESTS=1` makes missing service env fail instead of skip.
