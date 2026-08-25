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

Workers accept an update in-process through an optional semantic reload hook:

```ts
defineRuntimeWorker({
  definition,
  createRuntime() {
    return {
      start() {},
      reload(nextDefinition) {
        // Adopt the definition while preserving worker-owned state and IO.
      },
      stop() {},
    }
  },
})
```

Config, planner, host, logger, plugin, and infrastructure artifacts retain the
normal watcher and restart behavior. If a worker cannot accept an update, Neem
refreshes the complete output and replaces the runtime through its existing
reload path. The feature remains opt-in because Rolldown exposes DevEngine as
an experimental API.

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
