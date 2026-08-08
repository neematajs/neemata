import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import type { BaseServerDecoder, BaseServerEncoder } from './format.ts'
import type { ProtocolVersionInterface } from './protocol.ts'

/**
 * Delivery verdict of a transport send. Only 'dropped' signals a lost frame
 * the server must react to (credit revocation, stream aborts, connection
 * close); 'unknown' means the runtime provides no delivery feedback and must
 * never be treated as a drop.
 */
export type SendResult = 'delivered' | 'dropped' | 'unknown'

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
    send?: (connectionId: string, buffer: ArrayBufferView) => SendResult
  }
}

export type ResolveFormatParams = {
  contentType?: string | null
  accept?: string | null
}
