# @nmtjs/fastify

Neem runtime helpers for running Fastify applications behind the Neem proxy.
Each Neem worker owns one loopback Fastify listener and announces that listener
for both HTTP requests and WebSocket upgrades.

```ts
// api.planner.ts
import { defineFastifyPlanner } from '@nmtjs/fastify'

export default defineFastifyPlanner(() => ({ instances: 2 }))
```

```ts
// api.worker.ts
import websocket from '@fastify/websocket'
import { defineFastifyWorker } from '@nmtjs/fastify'
import Fastify from 'fastify'

export default defineFastifyWorker(async ({ logger }) => {
  const app = Fastify({ loggerInstance: logger })
  await app.register(websocket)

  app.get('/health', async () => ({ ok: true }))
  app.get('/socket', { websocket: true }, (socket) => {
    socket.on('message', (message) => socket.send(message))
  })

  return app
})
```

```ts
// api.runtime.ts
import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './api.planner.ts',
  proxy: { routing: { type: 'default' } },
  worker: { entry: './api.worker.ts' },
})
```

The runtime owns the listener, so application factories should configure and
return an unstarted Fastify HTTP/1 instance. `@fastify/websocket` and WebSocket
servers attached to `app.server` share that listener automatically. A separate
WebSocket listener needs a custom Neem worker that announces its own upstream.
Manual WebSocket attachments must close upgraded clients from a Fastify
shutdown hook so `app.close()` can finish.

With multiple instances, HTTP requests and WebSocket handshakes are balanced
independently. Applications should not require both connections to reach the
same worker.
