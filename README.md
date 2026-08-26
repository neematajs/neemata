# NeemataJS - RPC application server for real-time applications (proof of concept)

### Built with following in mind:

- transport-agnostic (like WebSockets, WebTransport, .etc)
- format-agnostic (like JSON, MessagePack, BSON, .etc)
- binary data streaming and event subscriptions
- contract-based API
- end-to-end type safety
- CPU-intensive task execution on separate workers

## Neem CLI draft

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

### Experimental backend HMR

Rolldown's native DevEngine can be enabled explicitly for runtime-worker
artifacts:

```ts
export default defineConfig({
  build: { experimentalDev: true },
  runtimes: ['./api.runtime.ts'],
})
```

Runtime packages can opt into in-process updates with a development-only
adapter. Keep its loader behind `import.meta.hot` so normal builds remove the
branch and adapter chunk:

```ts
defineRuntimeWorker({
  definition,
  createRuntime(ctx) {
    return createProductionRuntime(ctx)
  },
  ...(import.meta.hot
    ? {
        async hmr() {
          return (await import('./runtime.hmr.ts')).adapter
        },
      }
    : {}),
})
```

An adapter implements `NeemRuntimeHmrAdapter<Data, Definition>`: it receives
the complete current and replacement worker descriptors, creates its own
development runtime, and either accepts the update or asks Neem to replace the
complete runtime. The Neemata application adapter replaces
its application API and dependency container while keeping gateway transports
listening. The workflows adapter drains its current worker generation and
starts the updated implementations in the same Neem worker thread. Vite and
Nuxt omit this adapter: they continue to own their application module graphs
and use their native HMR, while an unaccepted worker update falls back to
Neem's existing runtime replacement path.

Config, planner, host, logger, plugin, and infrastructure artifacts retain the
normal watcher and restart behavior. Production builds force
`import.meta.hot` to `undefined`, so the worker HMR bootstrap and package
adapters are absent from their output. The feature remains opt-in because
Rolldown exposes DevEngine as an experimental API. For workflows, keep
pool/thread topology in a small
planner-only module; importing the executable workflow config into the planner
correctly makes implementation edits planner changes that require a restart.

## Service integration tests

Service-backed package integration tests live beside package owners under
`packages/*/tests/integration`.

Local services:

```sh
docker compose up -d --wait redis valkey kafka
```

Run required service tests:

```sh
NMTJS_REQUIRE_SERVICE_TESTS=1 \
REDIS_URL=redis://localhost:6379 \
VALKEY_URL=redis://localhost:6380 \
KAFKA_BROKERS=localhost:9092 \
pnpm run test:integration:services
```

Without service env, these tests skip in normal package/root test runs. In CI,
`NMTJS_REQUIRE_SERVICE_TESTS=1` makes missing service env fail instead of skip.
