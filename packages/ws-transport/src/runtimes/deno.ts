import type { Transport } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import createAdapter from 'crossws/adapters/deno'

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

type DenoServer = ReturnType<typeof globalThis.Deno.serve>
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

function adapterFactory(params: WsAdapterParams<'deno'>): WsAdapterServer {
  const adapter = createAdapter({ hooks: params.wsHooks })

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
        ...params.runtime?.server,
        ...options,
        handler: async (request: Request, info: any) => {
          const url = new URL(request.url)
          if (url.pathname === '/healthy') return StatusResponse()
          try {
            if (request.headers.get('upgrade') === 'websocket') {
              return await adapter.handleUpgrade(request, info as any)
            }
          } catch (err) {
            console.error('Error in WebSocket fetch handler', err)
            return InternalServerErrorHttpResponse()
          }
          return NotFoundHttpResponse()
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
    start: async () => {
      const { server: _server, addr } = await createServer()
      server = _server
      const proto = params.tls ? 'https' : 'http'

      switch (addr.transport) {
        case 'unix':
          return `${proto}+unix://${addr.path}`
        case 'tcp': {
          return `${proto}://${addr.hostname}:${addr.port}`
        }
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

export const WsTransport: Transport<
  ConnectionType.Bidirectional,
  WsTransportOptions<'deno'>,
  typeof injectables,
  ProxyableTransportType.WS
> = {
  proxyable: ProxyableTransportType.WS,
  injectables,
  factory(options) {
    return createWSTransportWorker(adapterFactory, options)
  },
}
