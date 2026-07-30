import type { MaybePromise, OneOf } from '@nmtjs/common'
import type {
  ServerHost,
  ServerListenOptions,
  ServerRequest,
  ServerRuntimeName,
  ServerRuntimeOptions,
  ServerTlsOptions,
  ServerWebSocketRuntimeOptions,
} from '@nmtjs/server'
import type { Hooks } from 'crossws'

export type WsTransportServerRequest = ServerRequest

export type WsTransportPeerContext = { connectionId: string }

declare module 'crossws' {
  interface PeerContext extends WsTransportPeerContext {}
}

export type WsTransportListenOptions = ServerListenOptions

export type WsTransportTlsOptions = ServerTlsOptions

export type WsTransportRuntimes = ServerRuntimeOptions

/**
 * The transport either owns its socket (`listen` mode) or mounts onto a
 * shared `ServerHost` (`server` mode), so one HTTP server can carry
 * multiple transports (e.g. HTTP and WS on a single listen address).
 */
export type WsTransportOptions<
  R extends ServerRuntimeName = ServerRuntimeName,
> = {
  /**
   * Raw websocket behavior overrides for the runtime. Unless set, the
   * transport applies its own defaults — on Node (uWS),
   * `maxPayloadLength` and `maxBackpressure` default to 1 MiB each: inline
   * WS payloads are capped at 1 MiB — larger data should ride blob
   * streams, which are chunked at credit size — and the value is
   * deliberately above the largest upload frame (64KiB credit grant plus
   * the frame header), since uWS closes the socket on oversized frames and
   * drops frames over the backpressure limit.
   */
  ws?: ServerWebSocketRuntimeOptions[R]
} & OneOf<
  [
    {
      listen: WsTransportListenOptions
      tls?: WsTransportTlsOptions
      runtime?: WsTransportRuntimes[R]
    },
    { server: ServerHost<R> },
  ]
>

export type WsAdapterParams<R extends ServerRuntimeName = ServerRuntimeName> =
  WsTransportOptions<R> & {
    wsHooks: Hooks
  }

export interface WsAdapterServer {
  stop: () => MaybePromise<any>
  start: () => MaybePromise<string>
  // numeric Peer.send() statuses are runtime-specific (uWS vs Bun), so only
  // the adapter that knows its runtime can interpret them as delivery success
  isSendSuccess?: (status: number) => boolean
}

export type WsAdapterServerFactory<
  R extends ServerRuntimeName = ServerRuntimeName,
> = (params: WsAdapterParams<R>) => WsAdapterServer
