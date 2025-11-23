import { randomUUID } from 'node:crypto'

import type { Container, Hooks, Logger } from '@nmtjs/core'
import type {
  ProtocolFormats,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/server'
import { throwError } from '@nmtjs/common'
import { getFormat } from '@nmtjs/protocol/server'

import type { TransportV2OnConnectOptions } from './transport.ts'
import { GatewayConnection } from './connection.ts'
import { GatewayHook } from './enums.ts'

export class GatewayConnections {
  readonly connections = new Map<string, GatewayConnection>()
  readonly signals = new Map<string, { disconnect: AbortController }>()

  constructor(
    private readonly application: {
      hooks: Hooks
      logger: Logger
      formats: ProtocolFormats
      container: Container
    },
  ) {}

  get(connectionId: string) {
    const connection = this.connections.get(connectionId)
    if (!connection) throwError('Connection not found')
    return connection
  }

  async open({
    id,
    container,
    identity,
    options,
    transport,
    protocol,
  }: {
    id: string
    transport: string
    identity: string
    container: Container
    protocol: ProtocolVersionInterface
    options: TransportV2OnConnectOptions
  }) {
    const { accept, contentType, type } = options
    const { decoder, encoder } = getFormat(this.application.formats, {
      accept,
      contentType,
    })
    const connection = new GatewayConnection({
      id,
      type,
      identity,
      transport,
      protocol,
      container,
      encoder,
      decoder,
    })
    const signals = { disconnect: new AbortController() }
    this.signals.set(id, signals)
    try {
      this.connections.set(id, connection)
      await this.initialize(connection)
      return { connection, signals }
    } catch (error) {
      container.dispose()
      // TODO: proper error handling/logging
      throw error
    }
  }

  async close(connectionId: string) {
    const connection = this.get(connectionId)
    const signals = this.signals.get(connectionId)

    const reason = new Error('Connection closed')

    await this.application.hooks.callHookParallel(
      GatewayHook.Disconnect,
      connection,
    )

    if (signals) {
      signals.disconnect.abort(reason)
      this.signals.delete(connectionId)
    }

    const { rpcs, serverStreams, clientStreams, container } = connection

    for (const call of rpcs.values()) {
      call.abort(reason)
    }

    for (const stream of clientStreams.values()) {
      stream.destroy(reason)
    }

    for (const stream of serverStreams.values()) {
      stream.destroy(reason)
    }

    this.connections.delete(connectionId)

    await container.dispose()
  }

  async closeAll() {
    await Promise.all(
      Array.from(this.connections.keys()).map((id) => this.close(id)),
    )
  }

  async initialize(connection: GatewayConnection) {
    await this.application.hooks.callHookParallel(
      GatewayHook.Connect,
      connection,
    )
  }
}
