import { createTransport } from '@nmtjs/protocol/server'
import createAdapter from 'crossws/adapters/bun'
import { WsTransportServer } from '../server.ts'
import type {
  WsAdapterParams,
  WsAdapterServer,
  WsConnectionData,
  WsTransportOptions,
} from '../types.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
} from '../utils.ts'

function adapterFactory(params: WsAdapterParams<'bun'>): WsAdapterServer {
  const adapter = createAdapter({ hooks: params.wsHooks })

  let server: Bun.Server | null = null

  function createServer() {
    return globalThis.Bun.serve({
      ...params.runtime?.server,
      unix: params.listen.unix,
      port: params.listen.port,
      hostname: params.listen.hostname,
      reusePort: params.listen.reusePort,
      tls: params.tls
        ? {
            cert: params.tls.cert,
            key: params.tls.key,
            passphrase: params.tls.passphrase,
          }
        : undefined,
      websocket: {
        ...params.runtime?.ws,
        ...adapter.websocket,
      },

      async fetch(request, server) {
        if (request.url.startsWith(params.apiPath)) {
          if (request.headers.get('upgrade') === 'websocket') {
            return adapter.handleUpgrade(request, server)
          }
          try {
            return await params.fetchHandler(request)
          } catch {
            return InternalServerErrorHttpResponse()
          }
        }
        return NotFoundHttpResponse()
      },
    })
  }

  return {
    start: () => {
      server = createServer()
    },
    stop: async () => {
      if (server) {
        await server.stop()
        server = null
      }
    },
  }
}

export const WsTransport = createTransport<
  WsConnectionData,
  WsTransportOptions<'bun'>
>('WsTransport', (context, options) => {
  return new WsTransportServer(adapterFactory, context, options)
})
