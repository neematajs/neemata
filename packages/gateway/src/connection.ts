import type { Container } from '@nmtjs/core'
import type { ConnectionType } from '@nmtjs/protocol'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  ProtocolClientStream,
  ProtocolServerStream,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/server'
import { MAX_UINT32 } from '@nmtjs/common'

import type { GatewayConnectionRpc } from './types.ts'

export class GatewayConnection {
  readonly id: string
  readonly type: ConnectionType
  readonly transport: string
  readonly protocol: ProtocolVersionInterface
  readonly identity: string
  readonly container: Container
  readonly encoder: BaseServerEncoder
  readonly decoder: BaseServerDecoder

  readonly rpcs = new Map<number, GatewayConnectionRpc>()
  readonly clientStreams = new Map<number, ProtocolClientStream>()
  readonly serverStreams = new Map<number, ProtocolServerStream>()

  #streamId = 1

  constructor(options: {
    id: string
    type: ConnectionType
    transport: string
    protocol: ProtocolVersionInterface
    identity: string
    container: Container
    encoder: BaseServerEncoder
    decoder: BaseServerDecoder
  }) {
    this.id = options.id
    this.type = options.type
    this.transport = options.transport
    this.protocol = options.protocol
    this.identity = options.identity
    this.container = options.container
    this.encoder = options.encoder
    this.decoder = options.decoder
  }

  readonly getStreamId = () => {
    if (this.#streamId >= MAX_UINT32) {
      this.#streamId = 1
    }
    return this.#streamId++
  }
}
