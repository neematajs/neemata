import type { BaseClient } from '../core.ts'

export type ClientDisconnectReason = 'client' | 'server' | (string & {})

export type ClientPluginEvent =
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

export type ClientPlugin = (
  client: BaseClient<any, any, any, any, any>,
) => ClientPluginInstance
