---
title: Server Setup
description: Application definition, server configuration, neemata.config.ts, and
  project structure patterns.
---

# Server Setup

## Neemata Config (neemata.config.ts)

The config file defines application entry points and the server path:

```typescript
import { defineConfig } from 'nmtjs/config'

export default defineConfig({
  applications: {
    main: {
      specifier: './src/applications/main/index.ts',
      type: 'neemata',
    },
  },
  serverPath: './src/index.ts',
  externalDependencies: 'prod',
})
```

## Application Definition

Each application defines its transports, router, and optional guards/middleware:

```typescript
import { HttpTransport } from '@nmtjs/http-transport/node'
import { WsTransport } from '@nmtjs/ws-transport/node'
import { n } from 'nmtjs'

import { router } from './router.ts'
import { authGuard } from './guards/auth.ts'
import { loggingMiddleware } from './middleware/logging.ts'

export default n.app({
  transports: { ws: WsTransport, http: HttpTransport },
  router,
  guards: [authGuard],
  middlewares: [loggingMiddleware],
})
```

## Server Configuration

The server entry point orchestrates workers, proxy, store, and metrics:

```typescript
import { n } from 'nmtjs'

export default n.server({
  logger: { pinoOptions: { level: 'info' } },
  applications: {
    main: {
      threads: [
        {
          ws: { listen: { port: 3001, hostname: '127.0.0.1' } },
          http: { listen: { port: 3002, hostname: '127.0.0.1' } },
        },
      ],
    },
  },
  proxy: {
    port: 4000,
    hostname: '127.0.0.1',
    applications: {
      main: { routing: { default: true } },
    },
  },
})
```

## Project Structure

A typical Neemata project follows this layout:

```
project/
  neemata.config.ts              # defineConfig — app entries + server path
  src/
    index.ts                     # n.server({...}) — server configuration
    applications/
      main/
        index.ts                 # n.app({...}) — application definition
        router.ts                # n.rootRouter([...]) — route tree
        procedures/
          example.ts             # n.procedure({...}) — RPC handlers
        guards/
        middleware/
        injectables/
```
