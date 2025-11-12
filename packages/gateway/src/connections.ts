import { randomUUID } from 'node:crypto'

import type { Container, Hooks, Logger } from '@nmtjs/core'
import type {
  ProtocolFormats,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/server'
import { throwError } from '@nmtjs/common'

import type { TransportV2OnConnectOptions } from './transport.ts'
import { GatewayConnection } from './connection.ts'
import { GatewayHook } from './enums.ts'
import { getFormat } from './utils.ts'

export class GatewayConnections {
  readonly #collection = new Map<string, GatewayConnection>()

  constructor(
    private readonly application: {
      hooks: Hooks
      logger: Logger
      formats: ProtocolFormats
      container: Container
    },
  ) {}

  get(connectionId: string) {
    const connection = this.#collection.get(connectionId)
    if (!connection) throwError('Connection not found')
    return connection
  }

  async open({
    container,
    identity,
    options,
    transport,
    protocol,
  }: {
    transport: string
    identity: string
    container: Container
    protocol: ProtocolVersionInterface
    options: TransportV2OnConnectOptions
  }) {
    const id = randomUUID()
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
    try {
      this.#collection.set(id, connection)
      await this.initialize(connection)
      return connection
    } catch (error) {
      container.dispose()
      // TODO: proper error handling/logging
      throw error
    }
  }

  async close(connectionId: string) {
    const connection = this.get(connectionId)

    this.application.hooks.callConcurrent(GatewayHook.Disconnect, connection)

    this.#collection.delete(connectionId)

    const { rpcs, serverStreams, clientStreams, container } = connection

    for (const call of rpcs.values()) {
      call.abort(new Error('Connection closed'))
    }

    for (const stream of clientStreams.values()) {
      stream.destroy(new Error('Connection closed'))
    }

    for (const stream of serverStreams.values()) {
      stream.destroy(new Error('Connection closed'))
    }

    await container.dispose()
  }

  async initialize(connection: GatewayConnection) {
    await this.application.hooks.callConcurrent(GatewayHook.Connect, connection)
  }
}
