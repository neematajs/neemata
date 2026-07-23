import type { MaybePromise, OneOf } from '@nmtjs/common'
import type { Hooks } from 'crossws'

export type WsTransportServerRequest = {
  url: URL
  method: string
  headers: Headers
  /**
   * Auth token offered by the client: taken from the `nmt.auth.*`
   * subprotocol, falling back to the deprecated `auth` query parameter.
   */
  auth: string | null
}

export type WsTransportPeerContext = { connectionId: string }

declare module 'crossws' {
  interface PeerContext extends WsTransportPeerContext {}
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
      import('bun').Serve.Options<any, any>,
      'development' | 'id' | 'maxRequestBodySize' | 'idleTimeout' | 'ipv6Only'
    >
  >
}

export type WsTransportRuntimeNode = {
  /**
   * Raw uWS websocket behavior overrides. Unless set, the transport applies
   * its own defaults for `maxPayloadLength` and `maxBackpressure` (1 MiB
   * each): inline WS payloads are capped at 1 MiB — larger data should ride
   * blob streams, which are chunked at credit size — and the value is
   * deliberately above the largest upload frame (64KiB credit grant plus the
   * frame header), since uWS closes the socket on oversized frames and drops
   * frames over the backpressure limit.
   */
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
  wsHooks: Hooks
  cors?: WsTransportCorsOptions
  tls?: WsTransportTlsOptions
  runtime?: WsTransportRuntimes[R]
}

export interface WsAdapterServer {
  stop: () => MaybePromise<any>
  start: () => MaybePromise<string>
  // numeric Peer.send() statuses are runtime-specific (uWS vs Bun), so only
  // the adapter that knows its runtime can interpret them as delivery success
  isSendSuccess?: (status: number) => boolean
}

export type WsAdapterServerFactory<
  R extends keyof WsTransportRuntimes = keyof WsTransportRuntimes,
> = (params: WsAdapterParams<R>) => WsAdapterServer
