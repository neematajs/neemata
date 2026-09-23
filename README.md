# NeemataJS

Neem hosting and durable workflows. Applications own their RPC, HTTP and clients;
Neemata supervises their processes and coordinates their durable work.

| Package              | Purpose                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `@nmtjs/neem`        | Runtime host and CLI: planners, workers, proxy, health, plugins ([README](packages/neem/README.md))    |
| `@nmtjs/workflows`   | Typed tasks and workflow graphs with a PostgreSQL runtime ([README](packages/workflows/README.md))     |
| `@nmtjs/pubsub`      | Typed ephemeral publish/subscribe with Redis and Valkey adapters ([README](packages/pubsub/README.md)) |
| `@nmtjs/effect`      | Neem worker preset for a supervised Effect application ([README](packages/effect/README.md))           |
| `@nmtjs/metrics`     | Metrics plugin for a Neem project                                                                      |
| `@nmtjs/prom-client` | Prometheus client with worker-thread aggregation ([README](packages/prom-client/README.md))            |
| `@nmtjs/proxy`       | Rust reverse proxy and native Node.js bindings ([README](packages/proxy/README.md))                    |
| `@nmtjs/vite`        | Neem runtime for a Vite application                                                                    |
| `@nmtjs/nuxt`        | Neem runtime for a Nuxt application                                                                    |
| `@nmtjs/common`      | Utilities shared by the packages above                                                                 |

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

Worker edits restart runtimes within their existing threads, with fresh-bundle
thread restarts when needed; see [Runtime restart](packages/neem/README.md#runtime-restart).

Use `neem dev --env-files ../../.env` to load environment variables before config
evaluation and worker startup. See [development environment files](packages/neem/README.md)
for precedence and multiple-file usage.

## Workspace development

Use Node.js 24 through `vp` and pnpm. Proxy work also needs a stable Rust
toolchain with `rustfmt` and `clippy`, a C/C++ toolchain, CMake, and pkg-config.
On macOS, install the Xcode command-line tools first.

```sh
vp env exec pnpm install
vp env exec pnpm build
vp env exec pnpm test --reporter=agent
vp env exec pnpm check
```

The stack installs `@nmtjs/proxy` from npm at the version pinned in
`packages/neem/package.json`, so `pnpm build`, `pnpm test` and `pnpm check` need no
Rust toolchain. `pnpm test:proxy` runs the Rust and proxy integration suites and
builds a local debug binding; set `NEEM_INTERNAL_PROXY_MODULE` to
`packages/proxy/dist/index.js` to run Neem against it. CI does the same in the
**Test proxy** workflow, which runs only when `packages/proxy` changes.
`pnpm test:prom-client` runs the prom-client Vitest project, which the root Vitest
run also includes.

Package versions are committed and bumped by hand in pull requests. The eight
stack packages (`common`, `effect`, `metrics`, `neem`, `nuxt`, `pubsub`, `vite`,
`workflows`) share one version: `pnpm run version:stack <version>` sets it on all
of them. Proxy and prom-client are versioned independently; bump and release them
before a stack release that needs the new version; after a proxy release, update
the pinned version and peer range in `packages/neem/package.json`. After the bump
is merged, dispatch the matching workflow: **Publish Neem stack**, **Publish proxy** or
**Publish prom-client**. Each one reads the committed version and fails early if
it is already on npm. The stack workflow also fails if the stack versions differ,
or if the committed proxy or prom-client version has not been published yet. All
three workflows share one publishing queue, so releases run one at a time across
packages and branches.

Stack packages depend on each other with `workspace:*`, which publishes exact
versions. They depend on prom-client with `workspace:^` and on proxy through a
caret peer range, so both can be upgraded without a stack release. Proxy releases
build all seven native targets, generate the platform packages from
`packages/proxy/package.json`, and publish them with `napi pre-publish` before
publishing the wrapper. Generated `packages/proxy/npm/` directories are ignored
and are not workspace members. Git tags are `v<version>` for the stack,
`proxy-v<version>` for proxy, and `prom-client-v<version>` for prom-client.

Package-specific READMEs and licenses are retained; prom-client remains
Apache-2.0 and includes its upstream notices. Configure npm publishing access
for `publish-proxy.yml` on proxy and its platform packages, and for
`publish-prom-client.yml` on prom-client. Stack packages use `publish.yml`.

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
