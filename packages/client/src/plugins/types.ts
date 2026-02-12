import type { BaseClient } from '../core.ts'

export type ClientDisconnectReason = 'client' | 'server' | (string & {})

/**
 * Client plugin lifecycle contract.
 *
 * Ordering guarantees:
 * - `onInit`, `onConnect`, `onServerMessage`: registration order
 * - `onDisconnect`, `dispose`: reverse registration order
 */
export interface ClientPluginInstance {
  name?: string
  onInit?(): void
  onConnect?(): void | Promise<void>
  onDisconnect?(reason: ClientDisconnectReason): void | Promise<void>
  onServerMessage?(message: unknown, raw: ArrayBufferView): void
  dispose?(): void
}

export type ClientPlugin = (
  client: BaseClient<any, any, any, any, any>,
) => ClientPluginInstance
