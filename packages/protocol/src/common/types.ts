import type { ProtocolBlob, ProtocolBlobMetadata } from './blob.ts'

type Stream = any

export interface BaseProtocolError {
  code: string
  message: string
  data?: any
}

export type ProtocolRPCPayload = unknown

export type ProtocolRPCResponse<T = Stream> = {
  payload: any
  streams: Record<number, T>
}

export interface EncodeRPCContext<T = Stream> {
  addStream: (blob: ProtocolBlob) => T
}

export interface DecodeRPCContext<T = Stream> {
  addStream: (id: number, metadata: ProtocolBlobMetadata) => T
}
