import type { TransportV2 } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'

import type {
  HttpAdapterParams,
  HttpAdapterServer,
  HttpTransportOptions,
} from '../types.ts'
import * as injectables from '../injectables.ts'
import { createHTTPTransportWorker } from '../server.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  StatusResponse,
} from '../utils.ts'

function adapterFactory(params: HttpAdapterParams<'bun'>): HttpAdapterServer {
  let server: Bun.Server<undefined> | null = null

  function createServer() {
    return globalThis.Bun.serve({
      ...params.runtime,
      unix: params.listen.unix as string,
      port: params.listen.port ?? 0,
      hostname: params.listen.hostname,
      reusePort: params.listen.reusePort,
      tls: params.tls
        ? {
            cert: params.tls.cert,
            key: params.tls.key,
            passphrase: params.tls.passphrase,
          }
        : undefined,
      // @ts-expect-error
      routes: {
        ...params.runtime?.routes,
        '/healthy': { GET: StatusResponse },
      },
      async fetch(request, server) {
        const url = new URL(request.url)
        try {
          if (request.headers.get('upgrade') === 'websocket')
            return NotFoundHttpResponse()
          const { body, headers, method } = request
          return await params.fetchHandler(
            { url, method, headers },
            body,
            request.signal,
          )
        } catch (err) {
          // TODO: proper logging
          console.error(err)
          // params.logger.error({ err }, 'Error in fetch handler')
          return InternalServerErrorHttpResponse()
        }
      },
    })
  }

  return {
    runtime: {
      get bun() {
        return server!
      },
    },
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

export const HttpTransport: TransportV2<
  ConnectionType.Unidirectional,
  HttpTransportOptions<'deno'>,
  typeof injectables,
  ProxyableTransportType.HTTP
> = {
  proxyable: ProxyableTransportType.HTTP,
  injectables,
  factory(options) {
    return createHTTPTransportWorker(adapterFactory, options)
  },
}
