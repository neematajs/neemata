import type { PlainType } from '@nmtjs/type/_plain'

import type { ProtocolBlobInterface } from '../common/blob.ts'
import type { ProtocolClientStream } from './stream.ts'

export type InputType<T> = T extends ProtocolBlobInterface
  ? ProtocolClientStream
  : T extends { [PlainType]?: true }
    ? { [K in keyof Omit<T, PlainType>]: InputType<T[K]> }
    : T

export type ProtocolSendMetadata = {
  streamId?: number
  callId?: number
  error?: any
}
