import type { Transport } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import createAdapter from 'crossws/adapters/bun'

import type {
  WsAdapterParams,
  WsAdapterServer,
  WsTransportOptions,
} from '../types.ts'
import * as injectables from '../injectables.ts'
import { createWSTransportWorker } from '../server.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  StatusResponse,
} from '../utils.ts'

function adapterFactory(params: WsAdapterParams<'bun'>): WsAdapterServer {
  const adapter = createAdapter({ hooks: params.wsHooks })

  let server: Bun.Server<any> | null = null

  function createServer() {
    return globalThis.Bun.serve(
      // @ts-expect-error ts bs
      {
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
        routes: { '/healthy': StatusResponse() },
        async fetch(request, server) {
          try {
            if (request.headers.get('upgrade') === 'websocket') {
              return await adapter.handleUpgrade(request, server)
            }
          } catch (err) {
            console.error('Error in WebSocket fetch handler', err)
            return InternalServerErrorHttpResponse()
          }
          return NotFoundHttpResponse()
        },
      },
    )
  }

  return {
    start: async () => {
      server = createServer()
      return server!.url.href
    },
    stop: async () => {
      if (server) {
        await server.stop()
        server = null
      }
    },
  }
}

export const WsTransport: Transport<
  ConnectionType.Bidirectional,
  WsTransportOptions<'bun'>,
  typeof injectables,
  ProxyableTransportType.HTTP
> = {
  proxyable: ProxyableTransportType.HTTP,
  injectables,
  factory(options) {
    return createWSTransportWorker(adapterFactory, options)
  },
}
