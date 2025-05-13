import type { ProtocolBlob, ProtocolBlobInterface } from '../common/blob.ts'
import type { ProtocolServerBlobStream } from './stream.ts'

export type InputType<T> = T extends ProtocolBlobInterface
  ? ProtocolBlob
  : T extends object
    ? { [K in keyof T]: InputType<T[K]> }
    : T

export type OutputType<T> = T extends ProtocolBlobInterface
  ? ProtocolServerBlobStream
  : T extends object
    ? { [K in keyof T]: OutputType<T[K]> }
    : T
