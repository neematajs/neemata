import type { TransportV2 } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'

import type {
  DenoServer,
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

interface DenoNetAddr {
  transport: 'tcp' | 'udp'
  hostname: string
  port: number
}

interface DenoUnixAddr {
  transport: 'unix' | 'unixpacket'
  path: string
}

interface DenoVsockAddr {
  transport: 'vsock'
  cid: number
  port: number
}

type DenoAddr = DenoNetAddr | DenoUnixAddr | DenoVsockAddr

function adapterFactory(params: HttpAdapterParams<'deno'>): HttpAdapterServer {
  let server: DenoServer | null = null

  function createServer() {
    const listenOptions = params.listen.unix
      ? { path: params.listen.unix }
      : {
          port: params.listen.port,
          hostname: params.listen.hostname,
          reusePort: params.listen.reusePort,
        }
    const options = {
      ...listenOptions,
      tls: params.tls
        ? {
            cert: params.tls.cert,
            key: params.tls.key,
            passphrase: params.tls.passphrase,
          }
        : undefined,
    }

    return new Promise<{ server: DenoServer; addr: DenoAddr }>((resolve) => {
      const server = globalThis.Deno.serve({
        ...params.runtime,
        ...options,
        handler: async (request: Request, info: any) => {
          const url = new URL(request.url)
          if (url.pathname === '/healthy') {
            return StatusResponse()
          }
          try {
            if (request.headers.get('upgrade') === 'websocket') {
              return NotFoundHttpResponse()
            }
            const { headers, method, body } = request
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
        onListen(addr: DenoAddr) {
          setTimeout(() => {
            resolve({ server, addr })
          }, 1)
        },
      })
    })
  }

  return {
    runtime: {
      get deno() {
        return server!
      },
    },
    start: async () => {
      const { server: _server, addr } = await createServer()
      server = _server
      switch (addr.transport) {
        case 'unix':
        case 'unixpacket':
          return `unix://${addr.path}`
        case 'tcp':
        case 'udp': {
          const proto = params.tls ? 'https' : 'http'
          return `${proto}://${addr.hostname}:${addr.port}`
        }
        case 'vsock':
          return `vsock://${addr.cid}:${addr.port}`
        default:
          throw new Error(`Unsupported address transport`)
      }
    },
    stop: async () => {
      if (server) {
        await server.shutdown()
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
