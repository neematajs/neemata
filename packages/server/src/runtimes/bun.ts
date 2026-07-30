import createAdapter from 'crossws/adapters/bun'

import type {
  ServerHost,
  ServerHostOptions,
  ServerNativeHandles,
} from '../types.ts'
import { BaseServerHost } from '../host.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  OkResponse,
} from '../utils.ts'

class BunServerHost extends BaseServerHost<'bun'> {
  readonly runtime = 'bun' as const
  #server: Bun.Server<any> | null = null

  get native(): ServerNativeHandles {
    return { bun: this.#server ?? undefined }
  }

  // Bun send status: >0 = bytes sent, -1 = backpressure applied (will
  // drain), 0 = dropped — only a drop is a failed delivery
  override isSendSuccess(status: number): boolean {
    return status !== 0
  }

  protected async bind(): Promise<string> {
    const { listen, tls, runtime } = this.options
    const adapter = this.webSocket
      ? createAdapter({ hooks: this.webSocket.hooks })
      : null
    const wsOptions = this.webSocket?.options
    const fetchHandler = this.fetchHandler

    const routes =
      typeof runtime?.routes === 'object' && runtime.routes
        ? runtime.routes
        : {}

    this.#server = globalThis.Bun.serve({
      ...runtime,
      // Bun's own default (128MiB) applies when neither option is set
      maxRequestBodySize:
        runtime?.maxRequestBodySize ?? this.options.maxRequestBodySize,
      unix: listen.unix as string,
      port: listen.port ?? 0,
      hostname: listen.hostname,
      reusePort: listen.reusePort,
      tls: tls
        ? {
            cert: tls.cert,
            key: tls.key,
            passphrase: tls.passphrase,
          }
        : undefined,
      websocket: adapter ? { ...wsOptions, ...adapter.websocket } : undefined,
      // bare handler instead of a method map: health probes may use HEAD,
      // keep the route method-agnostic like the other runtime hosts
      routes: Object.assign({}, routes, {
        '/healthy': OkResponse,
      }) as any,
      async fetch(request: Request, server: Bun.Server<any>) {
        try {
          if (request.headers.get('upgrade') === 'websocket') {
            if (!adapter) return NotFoundHttpResponse()
            return await adapter.handleUpgrade(request, server)
          }
          if (!fetchHandler) return NotFoundHttpResponse()
          const url = new URL(request.url)
          const { body, headers, method } = request
          return await fetchHandler(
            { url, method, headers },
            body,
            request.signal,
          )
        } catch (err) {
          // TODO: proper logging
          console.error(err)
          return InternalServerErrorHttpResponse()
        }
      },
    } as any)

    // Bun reports unix sockets as `unix:///path`; keep the cross-runtime
    // `proto+unix://` contract instead
    if (listen.unix) {
      return `${tls ? 'https' : 'http'}+unix://${listen.unix}`
    }
    return this.#server!.url.href
  }

  protected async close(): Promise<void> {
    const server = this.#server
    this.#server = null
    if (server) await server.stop()
  }
}

export function createServerHost(
  options: ServerHostOptions<'bun'>,
): ServerHost<'bun'> {
  return new BunServerHost(options)
}
