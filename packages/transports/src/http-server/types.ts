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

export type ServerFetchHandler = (request: Request) => MaybePromise<Response>

export type ServerFetchRegistration = {
  /** Claims this pathname and every descendant path segment. */
  path: `/${string}`
  handler: ServerFetchHandler
}

/**
 * Protocol floors a WebSocket handler declares at mount time. The host
 * validates them against its runtime-wide `webSocket` configuration at
 * start, so a config conflict is a loud startup error instead of frames
 * silently dropped (or sockets killed) at runtime.
 */
export type ServerWebSocketRequirements = {
  /**
   * Smallest inbound frame size the handler's protocol needs the host to
   * accept (bytes).
   */
  minPayloadLength?: number
}

export type ServerWebSocketRegistration = {
  /** Claims this pathname and every descendant path segment. */
  path: `/${string}`
  hooks: Partial<Hooks>
  requirements?: ServerWebSocketRequirements
}

/**
 * Host-wide WebSocket behavior overrides per runtime. Bun and uWS accept one
 * WebSocket configuration per native server, so these cannot vary by
 * handler; handlers instead declare `requirements` on their registration and
 * the host rejects a configuration below any mounted handler's floor.
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
     * consistent across runtimes). Handlers inherit this bound and may only
     * tighten it.
     */
    maxRequestBodySize?: number
    webSocket?: ServerWebSocketRuntimeOptions[R]
    runtime?: ServerRuntimeOptions[R]
  }

export type DenoServer = ReturnType<typeof globalThis.Deno.serve>

export type ServerNativeHandles = {
  node?: import('uWebSockets.js').TemplatedApp
  bun?: import('bun').Server<any>
  deno?: DenoServer
}

/**
 * A runtime HTTP server that handlers mount onto instead of owning a socket.
 * One host can carry HTTP path prefixes and WebSocket upgrade handlers on a
 * single listen address.
 *
 * A ServerTransport owns this lifecycle and mounts protocol handlers before
 * binding the socket. Every routing decision — reserved paths, WebSocket vs
 * fetch, longest-prefix match, 404 — is made by one router shared by all
 * runtimes, so observable behavior cannot diverge between them.
 */
export interface ServerHost<R extends ServerRuntimeName = ServerRuntimeName> {
  readonly runtime: R
  /**
   * Raw runtime server handle; populated only while the host is bound.
   */
  readonly native: ServerNativeHandles
  /**
   * Effective request body cap handlers inherit; see
   * `ServerHostOptions.maxRequestBodySize`.
   */
  readonly maxRequestBodySize: number
  mountFetchHandler(registration: ServerFetchRegistration): () => void
  mountWebSocket(registration: ServerWebSocketRegistration): () => void
  /**
   * Numeric WebSocket peer send() statuses are runtime-specific (uWS vs
   * Bun), so only the host knows whether one means a dropped frame.
   */
  isSendSuccess(status: number): boolean
  start(): Promise<string>
  stop(): Promise<void>
}
