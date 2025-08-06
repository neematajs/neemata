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

    return new Promise<DenoServer>((resolve) => {
      const server = globalThis.Deno.serve({
        ...params.runtime?.server,
        ...options,
        handler: async (request: Request, info: any) => {
          const url = new URL(request.url)
          if (url.pathname.startsWith(params.apiPath)) {
            if (request.headers.get('upgrade') === 'websocket') {
              return adapter.handleUpgrade(request, info as any)
            }
            try {
              return await params.fetchHandler(request)
            } catch {
              return InternalServerErrorHttpResponse()
            }
          }
          return NotFoundHttpResponse()
        },
        onListen(localAddr) {
          resolve(server)
        },
      })
    })
  }

  return {
    start: async () => {
      server = await createServer()
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
