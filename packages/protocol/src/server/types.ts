import type { PlainType } from '@nmtjs/type/_plain'

import type { ProtocolBlobInterface } from '../common/blob.ts'
import type { Connection } from './connection.ts'
import type { ProtocolHook } from './enums.ts'
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

declare module '@nmtjs/core' {
  export interface HookTypes {
    [ProtocolHook.Connect]: [connection: Connection]
    [ProtocolHook.Disconnect]: [connection: Connection]
  }
}
