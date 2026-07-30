import type { MaybePromise, OneOf } from '@nmtjs/common'
import type { Hooks } from 'crossws'

export type ServerRuntimeName = 'node' | 'bun' | 'deno'

export type ServerListenOptions = OneOf<
  [{ port: number; hostname?: string; reusePort?: boolean }, { unix: string }]
>

export type ServerTlsOptions = {
  /**
   * File path or inlined TLS certificate in PEM format (required).
   */
  cert?: string
  /**
   * File path or inlined TLS private key in PEM format (required).
   */
  key?: string
  /**
   * Passphrase for the private key (optional).
   */
  passphrase?: string
}

export type ServerRequest = {
  url: URL
  method: string
  headers: Headers
}

export type ServerFetchHandler = (
  request: ServerRequest,
  body: ReadableStream | null,
  signal: AbortSignal,
) => MaybePromise<Response>

/**
 * WebSocket behavior overrides per runtime. These belong to the WebSocket
 * tenant of a host, not the host itself — though Bun applies them
 * server-wide, since `Bun.serve` accepts a single `websocket` config.
 */
export type ServerWebSocketRuntimeOptions = {
  node: Partial<
    Pick<
      import('uWebSockets.js').WebSocketBehavior<import('crossws').PeerContext>,
      | 'maxBackpressure'
      | 'maxPayloadLength'
      | 'maxLifetime'
      | 'closeOnBackpressureLimit'
      | 'idleTimeout'
      | 'compression'
      | 'sendPingsAutomatically'
    >
  >
  bun: Partial<
    Pick<
      import('bun').WebSocketHandler<import('crossws').PeerContext>,
      | 'backpressureLimit'
      | 'maxPayloadLength'
      | 'closeOnBackpressureLimit'
      | 'idleTimeout'
      | 'perMessageDeflate'
      | 'sendPings'
    >
  >
  deno: {}
}

export type ServerWebSocketRegistration<
  R extends ServerRuntimeName = ServerRuntimeName,
> = {
  hooks: Partial<Hooks>
  options?: ServerWebSocketRuntimeOptions[R]
}

/**
 * Server-level runtime options: settings that configure the socket/server
 * itself rather than any single protocol mounted on it.
 */
export type ServerRuntimeOptions = {
  node: {}
  bun: Partial<
    Pick<
      import('bun').Serve.Options<undefined>,
      'development' | 'id' | 'maxRequestBodySize' | 'idleTimeout' | 'ipv6Only'
    > &
      import('bun').Serve.Routes<any, any>
  >
  deno: {}
}

export type ServerHostOptions<R extends ServerRuntimeName = ServerRuntimeName> =
  {
    listen: ServerListenOptions
    tls?: ServerTlsOptions
    /**
     * Maximum request body size in bytes accepted by the host before the
     * request is rejected/aborted. Defaults to 128MiB (Bun's own default, kept
     * consistent across runtimes). Transports may enforce stricter caps of
     * their own on top of this bound.
     */
    maxRequestBodySize?: number
    runtime?: ServerRuntimeOptions[R]
  }

export type DenoServer = ReturnType<typeof globalThis.Deno.serve>

export type ServerNativeHandles = {
  node?: import('uWebSockets.js').TemplatedApp
  bun?: import('bun').Server<any>
  deno?: DenoServer
}

/**
 * A runtime HTTP server that transports mount onto instead of owning a
 * socket. One host can carry both an HTTP fetch handler and a WebSocket
 * upgrade handler, so multiple transports share a single listen address.
 *
 * Lifecycle is reference-counted: every registrant calls start()/stop()
 * through its own lifecycle, the socket binds on the first start() and
 * closes on the last stop().
 */
export interface ServerHost<R extends ServerRuntimeName = ServerRuntimeName> {
  readonly runtime: R
  /**
   * Raw runtime server handle; populated only while the host is bound.
   */
  readonly native: ServerNativeHandles
  setFetchHandler(handler: ServerFetchHandler): void
  setWebSocket(registration: ServerWebSocketRegistration<R>): void
  /**
   * Numeric WebSocket peer send() statuses are runtime-specific (uWS vs
   * Bun), so only the host knows whether one means a dropped frame.
   */
  isSendSuccess(status: number): boolean
  start(): Promise<string>
  stop(): Promise<void>
}
