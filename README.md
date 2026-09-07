# NeemataJS

A TypeScript RPC application framework for real-time applications (proof of concept).
Define a contract, implement it with typed dependencies, and expose it through
independently configured transports. The same building blocks extend to streams,
subscriptions, and durable workflows.

- **One contract across the stack.** Input and output schemas connect server
  implementations to typed client calls.
- **Streaming as an API primitive.** Async generators expose typed response
  streams; native transports support binary streaming and subscriptions.
- **Explicit dependency lifetimes.** Global, connection, call, and transient
  scopes, with inferred dependencies and resource disposal.
- **Application logic separate from hosting.** Compose HTTP and WebSocket
  handlers with explicit codecs; choose a Node.js, Bun, or Deno server host.
- **Durable work outside the request.** Typed tasks and workflow graphs with a
  PostgreSQL runtime, retries, cancellation, and worker execution.

## A contract both sides understand

Keep the contract in a shared module. It describes the public API without
importing the server implementation.

```ts
// contract.ts
import { c } from '@nmtjs/contract'
import { t } from '@nmtjs/type'

export const contract = c.router({
  routes: {
    greet: c.procedure({
      input: t.object({ name: t.string() }),
      output: t.object({ message: t.string() }),
    }),
    count: c.stream({
      input: t.object({ limit: t.integer().gte(1).lte(100) }),
      output: t.number(),
    }),
  },
})
```

The implementation builder infers handler inputs and checks their outputs
against the contract. Stream handlers yield one output value at a time.

```ts
// app.ts
import * as n from 'nmtjs'
import { contract } from './contract.ts'

const api = n.implementRouter(contract)

export const app = n.app({
  router: api({
    greet: api.greet((_ctx, { name }) => ({ message: `Hello, ${name}!` })),
    count: api.count(async function* (_ctx, { limit }) {
      for (let value = 1; value <= limit; value++) yield value
    }),
  }),
})
```

## Typed calls and streams on the client

Client methods follow the contract's route structure, with inferred arguments,
results, and stream chunks. This client targets the HTTP `/api` mount shown below.

```ts
// client.ts
import { StaticClient } from '@nmtjs/client'
import { HttpTransportFactory } from '@nmtjs/client/http'
import { ProtocolVersion } from '@nmtjs/protocol'
import { JsonCodec } from '@nmtjs/protocol/json/client'
import { contract } from './contract.ts'

const client = new StaticClient(
  { contract, protocol: ProtocolVersion.v1, codec: new JsonCodec() },
  HttpTransportFactory,
  { url: 'http://localhost:4000/api' },
)

const greeting = await client.call.greet({ name: 'Ada' })
console.log(greeting.message)

const stream = await client.stream.count({ limit: 3 })
for await (const value of stream) {
  console.log(value) // 1, 2, 3 — each value is a number
}
```

Native HTTP streams use SSE; WebSocket streams use flow control to bound
in-flight chunks. Calls also accept an `AbortSignal` through `{ signal }`.
Binary streaming uses `ProtocolBlob`: HTTP supports top-level blob bodies,
while WebSocket supports blobs nested in RPC payloads.

## Dependencies with lifetimes

Declare dependencies where they are used. Factories receive typed values, and
the container resolves their dependency graph. For example, this alternative
`greet` implementation shares a request ID within each call:

```ts
// greet.ts
import * as n from 'nmtjs'
import { contract } from './contract.ts'

const requestId = n.factory({
  scope: n.Scope.Call,
  create: () => crypto.randomUUID(),
})

const requestLogger = n.factory({
  dependencies: { logger: n.inject.logger, requestId },
  create: ({ logger, requestId }) => logger.child({ requestId }),
})

export const greet = n.implementRouter(contract).greet({
  dependencies: { logger: requestLogger },
  handler: ({ logger }, { name }) => {
    logger.info('Greeting requested')
    return { message: `Hello, ${name}!` }
  },
})
```

`requestLogger` automatically inherits call scope from `requestId`. Factories
can also supply `dispose` to release resources when their container is disposed.
The same dependency mechanism is available to guards, middleware, and task
handlers.

## One application, composable transports

The application owns its router, API policies, plugins, and lifecycle hooks.
The host composes it with transports. Here, HTTP and WebSocket share one server
and the same JSON codec registry:

```ts
// host.ts
import * as n from 'nmtjs'
import { JsonCodec } from '@nmtjs/protocol/json/server'
import { ProtocolCodecRegistry } from '@nmtjs/protocol/server'
import { createServerTransport } from '@nmtjs/transports/http-server'
import { createServerHost } from '@nmtjs/transports/http-server/node'
import { neemataHttp } from '@nmtjs/transports/neemata/http'
import { neemataWebSocket } from '@nmtjs/transports/neemata/ws'
import { app } from './app.ts'

const codecs = new ProtocolCodecRegistry([new JsonCodec()])

export default n.host(app, {
  transports: {
    server: createServerTransport({
      host: createServerHost,
      handlers: {
        http: neemataHttp({ codecs }),
        ws: neemataWebSocket({ codecs }),
      },
    }),
  },
})
```

Listen addresses and handler paths are runtime options, supplied separately
when starting the host. For direct embedding:

```ts
// start.ts
import { createApplicationHost } from '@nmtjs/application'
import { createLogger, createValueInjectable } from '@nmtjs/core'
import host from './host.ts'

const runtime = createApplicationHost(host.application, {
  logger: createLogger({}, 'example'),
  transports: {
    server: {
      transport: host.transports.server,
      options: createValueInjectable({
        listen: { port: 4000, hostname: '127.0.0.1' },
        handlers: {
          http: { path: '/api' as const },
          ws: { path: '/ws' as const },
        },
      }),
    },
  },
})

await runtime.start()
// Call runtime.stop() during your application's shutdown.
```

The Node.js host uses `uWebSockets.js`. Bun and Deno hosts are available through
their corresponding `@nmtjs/transports/http-server/*` imports. MessagePack codecs
can be registered alongside JSON without changing handlers or application logic.

## Workflows with typed steps

Task contracts and workflow graphs are separate from their implementations.
Named steps expose typed outputs to subsequent input mappings:

```ts
// workflow.ts
import { t } from '@nmtjs/type'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'

const normalize = defineTask({
  name: 'normalize',
  input: t.string(),
  output: t.string(),
})

export const normalizeTask = implementTask(normalize, {
  handler: (_ctx, text) => text.trim().toLowerCase(),
})

export const wordCount = defineWorkflow({
  name: 'word-count',
  input: t.string(),
  output: t.number(),
})
  .task('normalized', normalize)
  .activity('counted', { input: t.string(), output: t.number() })
  .build()

export const wordCountWorkflow = implementWorkflow(wordCount)
  .normalized(normalize, { input: (_ctx, _outputs, input) => input })
  .counted((_ctx, text) => (text ? text.split(/\s+/).length : 0), {
    input: (_ctx, outputs) => outputs.normalized,
  })
  .finish((_ctx, outputs) => outputs.counted)
```

Graphs also support branches, parallel steps, nested workflows, and bounded
fan-out with `mapTask` / `mapWorkflow`. Register implementations with workflow
workers to execute them. The PostgreSQL runtime persists progress and supports
retrying failed work while retaining successful nodes. See the
[workflow package](packages/workflows/README.md) for runtime setup and migration
requirements.

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
