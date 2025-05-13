import type { OneOf } from '@nmtjs/common'
import type { ProtocolBlob, ProtocolBlobMetadata } from './blob.ts'

type Stream = any

export interface BaseProtocolError {
  code: string
  message: string
  data?: any
}

export type ProtocolRPC = {
  callId: number
  namespace: string
  procedure: string
  payload: any
}

export type ProtocolRPCResponse<T = Stream> = OneOf<
  [
    {
      callId: number
      error: BaseProtocolError
    },
    {
      callId: number
      result: any
      streams: Record<number, T>
    },
  ]
>

export interface EncodeRPCContext<T = Stream> {
  getStream: (id: number) => T
  addStream: (blob: ProtocolBlob) => T
}

export interface DecodeRPCContext<T = Stream> {
  getStream: (id: number, callId: number) => T
  addStream: (id: number, callId: number, metadata: ProtocolBlobMetadata) => T
}
