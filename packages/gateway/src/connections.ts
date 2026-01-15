import type { Container } from '@nmtjs/core'
import type { ConnectionType } from '@nmtjs/protocol'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/server'
import { MAX_UINT32, throwError } from '@nmtjs/common'

export interface GatewayConnection {
  readonly id: string
  readonly type: ConnectionType
  readonly transport: string
  readonly protocol: ProtocolVersionInterface
  readonly identity: string
  readonly container: Container
  readonly encoder: BaseServerEncoder
  readonly decoder: BaseServerDecoder
  readonly abortController: AbortController
}

export class ConnectionManager {
  readonly connections = new Map<string, GatewayConnection>()
  readonly streamIds = new Map<string, number>()

  add(connection: GatewayConnection) {
    this.connections.set(connection.id, connection)
    this.streamIds.set(connection.id, 0)
  }

  get(id: string) {
    return this.connections.get(id) ?? throwError('Connection not found')
  }

  has(id: string) {
    return this.connections.has(id)
  }

  remove(id: string) {
    this.connections.delete(id)
    this.streamIds.delete(id)
  }

  getAll() {
    return this.connections.values()
  }

  getStreamId(connectionId: string) {
    let streamId = this.streamIds.get(connectionId)!
    if (streamId >= MAX_UINT32) streamId = 0
    this.streamIds.set(connectionId, streamId + 1)
    return streamId
  }
}
