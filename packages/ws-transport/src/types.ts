import type { ServerRequest } from '@nmtjs/server-host'

export type NeemataWebSocketRequest = ServerRequest

export type WsTransportPeerContext = { connectionId: string }

declare module 'crossws' {
  interface PeerContext extends WsTransportPeerContext {}
}

export interface NeemataWebSocketHandlerOptions {
  /**
   * Mount path; claims this pathname and every descendant path segment.
   * WebSocket runtime behavior (payload caps, backpressure, timeouts) is
   * host-wide — see `ServerHostOptions.webSocket` — because Bun and uWS
   * accept one WebSocket configuration per native server. This handler
   * declares its protocol floors via registration requirements, so a host
   * configured below them fails at start instead of dropping frames.
   */
  path: `/${string}`
}
