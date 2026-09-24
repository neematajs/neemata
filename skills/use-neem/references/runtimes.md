# Runtimes

Neem config declares named runtimes and controller plugins. Keep config and
runtime declarations free of live resources: they are evaluated for build/dev.
Create clients, listeners, and log transports in their owning runtime modules.

## Project Config

```ts
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: { pinoOptions: { level: 'info' } },
  env: { NODE_ENV: 'production' },
  outDir: 'dist',
  proxy: { hostname: '127.0.0.1', port: 3000 },
  health: { hostname: '127.0.0.1', port: 3001 },
  runtimes: [
    './src/runtimes/**/neem.runtime.ts',
    '!./src/runtimes/experimental/**',
  ],
})
```

`NeemConfig` requires `runtimes`. Its optional fields are `env`, `logger`,
`build`, `proxy`, `health`, `plugins`, and `outDir`:

- `env`: `Record<string, string>` baked into the manifest, not env-file paths.
- `logger`: `NeemLoggerOptions` or a string/file URL module entry; see below.
- `build`: `sourcemap`, `sourcemapSources: 'include' | 'exclude'`,
  `minify: boolean | 'dce-only'`, `define: Record<string, string>`,
  `watch: { buildDelay?, debounceDelay? }` (delays in milliseconds), and
  `updates: { maxPatches? }` (dev patches a thread accepts before the next
  update restarts the runtime; default `50`, `0` restarts on every update).
- `plugins`: readonly array of `NeemPluginInput` declarations.
- `outDir`: build output relative to the config file (default `dist`), also
  used by `neem start --config`. Dev uses its own directory; see
  [CLI](cli.md#commands-and-defaults).

Production start reads the manifest/artifacts; it evaluates source config only
with `neem start --config`. See [CLI](cli.md) for output paths and deployment
overrides below.

## Discovery and Declarations

- `runtimes` accepts file paths, folders, globs, and negated globs, relative to
  the config file's directory. Entries are processed in array order; each glob's
  matches are sorted. Exclusions apply regardless of their position; repeated
  files are deduplicated. Positive entries matching nothing fail.
- A folder must contain `neem.runtime.ts`, `.mts`, `.js`, or `.mjs`, checked in
  that order. CommonJS `.cts`/`.cjs` conventions are not supported.
- Each file must default-export a branded declaration from `defineRuntime` or
  a package helper. A plain object is not sufficient.
- Names use a nonempty trimmed `name`, otherwise the nearest ancestor
  `package.json` with a nonempty string `name`. No scope or prefix is stripped.
  Missing names and duplicate names fail, even before build selection.
- Every declaration needs a planner: explicit `planner`, a package default,
  or sibling `neem.planner.ts`, `.mts`, `.js`, `.mjs`, in that order.
- Supply `worker: { entry }` or `host: { entry }` (both are allowed). Without a
  custom host, Neem uses its default host. Worker entries are explicit; there
  is no conventional worker-file lookup.
- Entry values are strings or `file:` URL objects. Relative entries resolve
  from the declaration file; package specifiers use package resolution. Other
  URL protocols fail. Pass entries, not imported worker/planner/host objects.
- Planners and hosts execute in a runtime's host-runner thread; application
  workers execute in separate worker threads. Planner data must be structured
  cloneable. Do not share live clients through planner data.

Runtime declarations additionally accept `env`, `proxy`, and
`worker.build`/`host.build`. Build options have `rolldown` and `chunks` fields:
`chunks` is `false` or `{ groups?: readonly NeemChunkGroup[] }`;
`rolldown` exposes a restricted set of plugin, external, resolve, transform,
module type, check, and tsconfig options, not arbitrary output options.
`host.build` also applies to the planner artifact.

Use package helpers for their defaults; their call shapes differ. See
[package integration](package-integration.md) and [Effect](effect.md). For a
fully app-owned declaration:

```ts
import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './neem.planner.ts',
  worker: { entry: './neem.worker.ts' },
  proxy: { routing: { type: 'default' } },
})
```

Package helpers built on `createRuntime` merge env keys and worker/host build
options; caller values win and package Rolldown plugins precede caller plugins.
Caller `proxy.routing` replaces the whole routing mode. Detailed worker/host/
planner authoring belongs in `build-neem-runtime`, including `defineRuntimeHost`,
`defineRuntimeWorker`, `defineRuntimePlanner`, and their brand guards.

## Environment

For planner, host, and worker threads, precedence is config `env`, then runtime
`env`, then live process environment (highest). Inline env is a deployment
fallback, not a way to override externally supplied values. It does not set the
controller plugin's process environment.

Use [`neem dev --env-files`](cli.md#environment-files) for files loaded before
config evaluation. `envFiles` is not a config property.

## Proxy and Health

Install Neem's optional peer `@nmtjs/proxy@1.0.0-beta.9` when enabling `proxy`.
The controller config takes required `hostname` and `port`, plus optional
`healthChecks: { interval? }`, `stickySessions: { enabled?, cookieName?,
headerName?, ttlMs?, maxEntries? }`, `limits`, and `tls: { keyPath, certPath }`.

`limits` takes `maxUriSize` (default 8 KiB), `maxRequestHeaders` (100),
`maxSingleHeaderSize` (8 KiB), `maxRequestHeaderSize` (64 KiB), and
`maxRequestBodySize` (16 MiB). Sizes are bytes. `null` disables one check;
`limits: null` disables all of them. The body limit is checked against the
declared `Content-Length` only, so chunked uploads are not limited by the proxy.

Routing belongs on each runtime's `proxy`, not `NeemConfig.proxy.runtimes`:

- Omit runtime `proxy` to exclude that runtime from proxy routing.
- `proxy: {}` defaults to path routing with the runtime name.
- `routing` is `{ type: 'path', name? }`, `{ type: 'subdomain', name? }`, or
  `{ type: 'default' }`. At most one selected runtime may have the default route.
  Missing path/subdomain `name` uses the full runtime name.
- Runtime `proxy.sni` is optional. Workers report `{ type, url }` upstreams,
  where `type` is `'http'`, `'http2'`, or `'ws'`.
- Runtime `proxy.maxRequestBodySize` overrides `limits.maxRequestBodySize` for
  that runtime. `null` lets any size through so the runtime enforces its own
  limit, e.g. for large streamed uploads.
- Proxy errors: no matching route is 404; a matched runtime without a live
  upstream (restarting, failed, or unhealthy) is 503 with `Retry-After: 1`;
  a failed connection to a chosen upstream is 502; an exceeded limit is 413,
  414, or 431. These carry a `text/plain` body and echo the request `Origin` in
  CORS headers so browser clients can read them. Application responses pass
  through unchanged.

`health` enables a separate HTTP probe server. It requires `port`, defaults
`hostname` to `127.0.0.1`, and accepts `paths: { health?, ready? }` (defaults
`/health`, `/ready`). GET and HEAD are supported:

- `/health` returns 503 for server state `failed` or `stopped`, otherwise 200.
- `/ready` returns 200 only when the server is running, every runtime pool is
  ready, and an enabled proxy is ready; otherwise 503. Use readiness during
  startup, reload, and recovery. Responses include the health snapshot.

Deploy-time process variables override built networking values:

| Setting              | Environment variable                                  |
| -------------------- | ----------------------------------------------------- |
| Proxy port           | `NEEM_PROXY_PORT`, then `PORT`                        |
| Proxy hostname       | `NEEM_PROXY_HOSTNAME`                                 |
| TLS paths            | `NEEM_PROXY_TLS_KEY_PATH`, `NEEM_PROXY_TLS_CERT_PATH` |
| Health port/hostname | `NEEM_HEALTH_PORT`, `NEEM_HEALTH_HOSTNAME`            |

Empty values are ignored. Port overrides must be integers from 0 to 65535.
These variables do not enable absent proxy/health servers. Enabling TLS on an
existing proxy with no built TLS config requires both paths. With built TLS,
either path can be overridden separately.

## Logger and Plugins

Inline logger options use `NeemLoggerOptions` (`pinoOptions`, `destinations`),
but only JSON-serializable settings survive the manifest. For streams,
transports, functions, or env-sensitive setup, set `logger` to a module entry
that default-exports a Pino `Logger`; open resources there. Logger modules load
in the contexts that use them, not as a shared cross-thread instance. Default
levels are `debug` in development and `info` in production.

A plugin declaration has `{ name, entry?, options?, build? }`; use
`definePlugin` or a package helper. `name` must be nonempty; keep `options`
JSON-serializable. `build.rolldown` contributes runtime worker build options;
`entry` is optional for build-only plugins. Config-relative module entries are
built as artifacts, and their default export is a factory normally wrapped in
`definePluginHooks`.

The factory receives `{ name, mode, options, logger, getHealth }` and returns
hooks (possibly asynchronously). Hooks include `initialize`, `dispose`,
`server:start/ready/reload/stop/fail`, `runtime:start/ready/reload/stop/fail`, and
`worker:start/ready/stop/fail`. Events include `mode` and optional `error`;
runtime events add `name`/optional `upstreams`, worker events add
`id`, `name`, `artifactId`, and `owner`.

Plugins run in the controller context: the runtime service worker for CLI
`dev`/`start`, or the main thread for generated standalone entries. Allocate
plugin resources in lifecycle hooks and release them in `dispose`.
`getHealth()` exposes server, runtime pool/thread, and proxy state.
`NeemWorkerError` identifies worker-reported failures via `worker` and `origin`
(`'bootstrap' | 'start' | 'runtime'`). Its `cause` is the rendered error sent
across the thread boundary, not the original application value.

For metrics, use [the metrics plugin](metrics.md) in `plugins`, never `runtimes`.
