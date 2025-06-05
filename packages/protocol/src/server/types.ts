import type { ProtocolBlob, ProtocolBlobInterface } from '../common/blob.ts'
import type { ProtocolClientStream } from './stream.ts'

export type InputType<T> = T extends ProtocolBlobInterface
  ? ProtocolClientStream
  : T extends object
    ? { [K in keyof T]: InputType<T[K]> }
    : T

export type OutputType<T> = T extends ProtocolBlobInterface
  ? ProtocolBlob
  : T extends object
    ? { [K in keyof T]: OutputType<T[K]> }
    : T

export type ProtocolSendMetadata = {
  streamId?: number
  callId?: number
  error?: any
}
