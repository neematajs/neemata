import type { PlainType } from '@nmtjs/type'

import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import type { kBlobKey } from '../common/constants.ts'
import type { BaseServerDecoder, BaseServerEncoder } from './format.ts'
import type { ProtocolVersionInterface } from './protocol.ts'
import type { ProtocolClientStream } from './stream.ts'

export type ClientStreamConsumer = (() => ProtocolClientStream) & {
  readonly [kBlobKey]: any
  readonly metadata: ProtocolBlobMetadata
}

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
  }) => ClientStreamConsumer
  transport: {
    send?: (connectionId: string, buffer: ArrayBufferView) => boolean | null
  }
}

export type ResolveFormatParams = {
  contentType?: string | null
  accept?: string | null
}

export type InputType<T> = T extends ProtocolBlobInterface
  ? ClientStreamConsumer
  : T extends { [PlainType]?: true }
    ? { [K in keyof Omit<T, PlainType>]: InputType<T[K]> }
    : T
