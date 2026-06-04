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
