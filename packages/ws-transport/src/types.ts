import type { Async, OneOf } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'
import type { Connection, ConnectionContext } from '@nmtjs/protocol/server'
import type { Hooks } from 'crossws'

export type WsConnectionData = { type: 'ws' | 'http' }

export type WsTransportServerRequest = {
  url: URL
  method: string
  headers: Headers
}

declare module 'crossws' {
  interface PeerContext {
    id: Connection['id']
    acceptType: string | null
    contentType: string | null
    context: ConnectionContext
    controller: AbortController
    request: WsTransportServerRequest
  }
}

export type WsTransportOptions<
  R extends keyof WsTransportRuntimes = keyof WsTransportRuntimes,
> = {
  listen: WsTransportListenOptions
  cors?: WsTransportCorsOptions
  tls?: WsTransportTlsOptions
  runtime?: WsTransportRuntimes[R]
}

export type WsTransportCorsCustomParams = {
  allowMethods?: string[]
  allowHeaders?: string[]
  allowCredentials?: string
  maxAge?: string
  exposeHeaders?: string[]
  requestHeaders?: string[]
  requestMethod?: string
}

export type WsTransportCorsOptions =
  | true
  | string[]
  | WsTransportCorsCustomParams
  | ((
      origin: string,
      request: WsTransportServerRequest,
    ) => boolean | WsTransportCorsCustomParams)

export type WsTransportListenOptions = OneOf<
  [{ port: number; hostname?: string; reusePort?: boolean }, { unix: string }]
>

export type WsTransportRuntimeBun = {
  ws?: Partial<
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
  server?: Partial<
    Pick<
      import('bun').ServeOptions,
      'development' | 'id' | 'maxRequestBodySize' | 'idleTimeout' | 'ipv6Only'
    > &
      Pick<import('bun').ServeFunctionOptions<any, any>, 'routes'>
  >
}

export type WsTransportRuntimeNode = {
  ws?: Partial<
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
}

export type WsTransportRuntimeDeno = { server?: {} }

export type WsTransportRuntimes = {
  bun: WsTransportRuntimeBun
  node: WsTransportRuntimeNode
  deno: WsTransportRuntimeDeno
}

export type WsTransportTlsOptions = {
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

export type WsAdapterParams<
  R extends keyof WsTransportRuntimes = keyof WsTransportRuntimes,
> = {
  listen: WsTransportListenOptions
  apiPath: string
  wsHooks: Hooks
  fetchHandler: (
    request: WsTransportServerRequest,
    body: ReadableStream | null,
    signal: AbortSignal,
  ) => Async<Response>
  logger: Logger
  cors?: WsTransportCorsOptions
  tls?: WsTransportTlsOptions
  runtime?: WsTransportRuntimes[R]
}

export interface WsAdapterServer {
  stop: () => Async<any>
  start: () => Async<string>
}

export type WsAdapterServerFactory<
  R extends keyof WsTransportRuntimes = keyof WsTransportRuntimes,
> = (params: WsAdapterParams<R>) => WsAdapterServer
