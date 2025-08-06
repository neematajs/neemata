import { createTransport } from '@nmtjs/protocol/server'
import createAdapter from 'crossws/adapters/deno'
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
          if (url.pathname.startsWith(params.apiPath)) {
            try {
              if (request.headers.get('upgrade') === 'websocket') {
                return await adapter.handleUpgrade(request, info as any)
              }

              const { headers, method, body } = request
              return await params.fetchHandler(
                {
                  url,
                  method,
                  headers,
                },
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
        onListen(addr: DenoAddr) {
          resolve({ server, addr })
        },
      })
    })
  }

  return {
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

export const WsTransport = createTransport<
  WsConnectionData,
  WsTransportOptions<'deno'>
>('WsTransport', (context, options) => {
  return new WsTransportServer(adapterFactory, context, options)
})
