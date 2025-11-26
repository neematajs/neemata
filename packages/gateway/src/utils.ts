import type { Container } from '@nmtjs/core'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  ProtocolClientStreams,
  ProtocolServerStreams,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/server'

import type { GatewayConnection } from './connection.ts'
import type { TransportWorker } from './transport.ts'

export type MessageContext = {
  protocol: ProtocolVersionInterface
  connectionId: string
  streamId: () => number
  decoder: BaseServerDecoder
  encoder: BaseServerEncoder
  rpcs: GatewayConnection['rpcs']
  serverStreams: ProtocolServerStreams
  clientStreams: ProtocolClientStreams
  transport: TransportWorker
  container: Container
}
