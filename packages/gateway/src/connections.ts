import type { Container, Hooks, Logger } from '@nmtjs/core'
import type {
  ProtocolFormats,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/server'
import { throwError } from '@nmtjs/common'
import { getFormat } from '@nmtjs/protocol/server'

import type {
  GatewayConnectionClientStreams,
  GatewayConnectionServerStreams,
} from './connection.ts'
import type { TransportOnConnectOptions } from './transport.ts'
import { GatewayConnection } from './connection.ts'
import { GatewayHook } from './enums.ts'
import * as injectables from './injectables.ts'

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
    clientStreams,
    serverStreams,
  }: {
    id: string
    transport: string
    identity: string
    container: Container
    protocol: ProtocolVersionInterface
    options: TransportOnConnectOptions
    clientStreams: GatewayConnectionClientStreams
    serverStreams: GatewayConnectionServerStreams
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
      clientStreams,
      serverStreams,
    })
    const signals = { disconnect: new AbortController() }
    this.signals.set(id, signals)
    await container.provide(
      injectables.connectionAbortSignal,
      signals.disconnect.signal,
    )
    this.connections.set(id, connection)
    await this.initialize(connection)
    return connection
  }

  async close(connectionId: string) {
    const connection = this.get(connectionId)
    const signals = this.signals.get(connectionId)

    const reason = 'Connection closed'

    await this.application.hooks.callHookParallel(
      GatewayHook.Disconnect,
      connection,
    )

    if (signals) {
      signals.disconnect.abort(new Error(reason))
      this.signals.delete(connectionId)
    }

    const { rpcs, serverStreams, clientStreams, container } = connection

    rpcs.close(reason)
    clientStreams.close(reason)
    serverStreams.close(reason)

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
