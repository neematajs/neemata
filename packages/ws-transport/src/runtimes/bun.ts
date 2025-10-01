import { createTransport } from '@nmtjs/protocol/server'
import createAdapter from 'crossws/adapters/bun'

import type {
  WsAdapterParams,
  WsAdapterServer,
  WsConnectionData,
  WsTransportOptions,
} from '../types.ts'
import { WsTransportServer } from '../server.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  StatusResponse,
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
      websocket: { ...params.runtime?.ws, ...adapter.websocket },
      routes: {
        ...params.runtime?.server?.routes,
        '/healthy': StatusResponse(),
      },
      async fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname.startsWith(params.apiPath)) {
          try {
            if (request.headers.get('upgrade') === 'websocket') {
              return await adapter.handleUpgrade(request, server)
            }
            const { body, headers, method } = request
            return await params.fetchHandler(
              { url, method, headers },
              body,
              request.signal,
            )
          } catch (err) {
            params.logger.error({ err }, 'Error in fetch handler')
            return InternalServerErrorHttpResponse()
          }
        }
        return NotFoundHttpResponse()
      },
    })
  }

  return {
    start: async () => {
      server = createServer()
      return server.url.href
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
