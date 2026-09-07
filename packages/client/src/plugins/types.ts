import type { ClientCore } from '../core.ts'
import type { ClientDisconnectReason } from '../transport.ts'
import type { ConnectionState, PingLayerApi } from '../types.ts'

export type ClientLogEvent = ClientPluginEvent

export interface LoggingPluginOptions {
  includeBodies?: boolean
  onEvent(event: ClientLogEvent): void | Promise<void>
  mapEvent?(event: ClientLogEvent): ClientLogEvent | null
  onSinkError?(error: unknown, event: ClientLogEvent): void
}

export interface ReconnectPluginOptions {
  initialTimeout?: number
  maxTimeout?: number
}

export interface HeartbeatPluginOptions {
  interval?: number
  timeout?: number
}

export interface ReconnectConfig {
  initialTimeout?: number
  maxTimeout?: number
}

export type StreamEvent = {
  direction: 'incoming' | 'outgoing'
  streamType: 'rpc' | 'client_blob' | 'server_blob'
  action: 'response' | 'pull' | 'push' | 'end' | 'abort'
  callId?: number
  streamId?: number
  byteLength?: number
  reason?: string
}

export type ClientPluginEvent =
  | {
      kind: 'state_changed'
      timestamp: number
      state: ConnectionState
      previous: ConnectionState
    }
  | {
      kind: 'connected'
      timestamp: number
      transportType: 'bidirectional' | 'unidirectional'
    }
  | { kind: 'disconnected'; timestamp: number; reason: ClientDisconnectReason }
  | {
      kind: 'server_message'
      timestamp: number
      messageType: number | string
      rawByteLength: number
      body?: unknown
    }
  | {
      kind: 'rpc_request'
      timestamp: number
      callId: number
      procedure: string
      body?: unknown
    }
  | {
      kind: 'rpc_response'
      timestamp: number
      callId: number
      procedure: string
      body?: unknown
      stream?: boolean
    }
  | {
      kind: 'rpc_error'
      timestamp: number
      callId: number
      procedure: string
      error: unknown
    }
  | ({ kind: 'stream_event'; timestamp: number } & StreamEvent)

/**
 * Client plugin lifecycle contract.
 *
 * Ordering guarantees:
 * - `onInit`, `onConnect`, `onServerMessage`, `onClientEvent`: registration order
 * - `onDisconnect`, `dispose`: reverse registration order
 */
export interface ClientPluginInstance {
  name?: string
  onInit?(): void
  onConnect?(): void | Promise<void>
  onDisconnect?(reason: ClientDisconnectReason): void | Promise<void>
  onServerMessage?(message: unknown, raw: ArrayBufferView): void
  onClientEvent?(event: ClientPluginEvent): void | Promise<void>
  dispose?(): void
}

export interface ClientPluginContext {
  core: ClientCore
  ping: PingLayerApi
}

export type ClientPlugin = (
  context: ClientPluginContext,
) => ClientPluginInstance
