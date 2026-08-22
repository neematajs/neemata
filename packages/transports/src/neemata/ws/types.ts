import type { ProtocolCodecRegistry } from '@nmtjs/protocol/server'

import type { WsSessionHeartbeatOptions } from './session.ts'

export type NeemataWebSocketRequest = Request

export type WsTransportPeerContext = { connectionId: string }

export interface NeemataWebSocketOptions {
  /** Codecs available to this native Neemata WebSocket handler. */
  codecs: ProtocolCodecRegistry
}

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
  /**
   * Bounds peer inactivity per stream; see the session engine for exact
   * semantics. Defaults to 30s.
   */
  streamIdleTimeout?: number
  /**
   * Server-initiated protocol heartbeat (Ping/Pong). `false` disables it;
   * a missed Pong closes the connection.
   */
  heartbeat?: WsSessionHeartbeatOptions
}
