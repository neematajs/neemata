import createAdapter from 'crossws/adapters/bun'

import type {
  ServerHost,
  ServerHostOptions,
  ServerNativeHandles,
} from './types.ts'
import { BaseServerHost } from './host.ts'

/** Bun.serve's own default inbound WebSocket frame cap. */
const BUN_DEFAULT_WS_MAX_PAYLOAD = 1024 * 1024 * 16

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

  override get maxRequestBodySize(): number {
    return this.options.runtime?.maxRequestBodySize ?? super.maxRequestBodySize
  }

  protected override get effectiveWsMaxPayloadLength(): number | undefined {
    return (
      this.options.webSocket?.maxPayloadLength ?? BUN_DEFAULT_WS_MAX_PAYLOAD
    )
  }

  protected async bind(): Promise<string> {
    const { listen, tls, runtime } = this.options
    if (!listen.unix && typeof listen.port !== 'number') {
      throw new Error('Invalid listen parameters')
    }

    const adapter = this.hasWebSockets
      ? createAdapter(this.createWsAdapterConfig())
      : null

    const routes =
      typeof runtime?.routes === 'object' && runtime.routes
        ? runtime.routes
        : {}

    const dispatchFetch = this.dispatchFetch.bind(this)
    const respondToUpgrade = this.respondToUpgrade.bind(this)

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
      websocket: adapter
        ? { ...this.options.webSocket, ...adapter.websocket }
        : undefined,
      routes: routes as any,
      async fetch(request: Request, server: Bun.Server<any>) {
        const url = new URL(request.url)
        if (request.headers.get('upgrade') === 'websocket') {
          if (!adapter) return respondToUpgrade(url.pathname)
          return await adapter.handleUpgrade(request, server)
        }
        return await dispatchFetch(request)
      },
    } as any)

    // Bun reports unix sockets as `unix:///path`; keep the cross-runtime
    // `proto+unix://` contract instead
    if (listen.unix) {
      return `${tls ? 'https' : 'http'}+unix://${listen.unix}`
    }
    return this.#server!.url.origin
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
