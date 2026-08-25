import type { Container } from '@nmtjs/core'
import { throwError } from '@nmtjs/common'

/**
 * Application-session handle: what one connection *means* to the application
 * (identity, DI scope, lifetime). Everything wire-level — protocol version,
 * codecs, frame state — is owned by the transport handler that opened it;
 * the handler decides what a connection represents (an HTTP request, a
 * WebSocket session, an MCP request).
 */
export interface GatewayConnection {
  readonly id: string
  identity: string
  container: Container
  readonly abortController: AbortController
}

export class ConnectionManager {
  readonly connections = new Map<string, GatewayConnection>()

  add(connection: GatewayConnection) {
    this.connections.set(connection.id, connection)
  }

  get(id: string) {
    return this.connections.get(id) ?? throwError('Connection not found')
  }

  has(id: string) {
    return this.connections.has(id)
  }

  remove(id: string) {
    this.connections.delete(id)
  }

  getAll() {
    return this.connections.values()
  }
}
