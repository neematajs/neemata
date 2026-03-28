import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import type { BaseServerDecoder, BaseServerEncoder } from './format.ts'
import type { ProtocolVersionInterface } from './protocol.ts'

export type MessageContext = {
  protocol: ProtocolVersionInterface
  connectionId: string
  streamId: () => number
  decoder: BaseServerDecoder
  encoder: BaseServerEncoder
  addClientStream: (options: {
    streamId: number
    metadata: ProtocolBlobMetadata
    callId: number
  }) => ProtocolBlobInterface
  transport: {
    send?: (connectionId: string, buffer: ArrayBufferView) => boolean | null
  }
}

export type ResolveFormatParams = {
  contentType?: string | null
  accept?: string | null
}
