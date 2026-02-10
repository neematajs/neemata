import type { ProtocolBlobMetadata } from './blob.ts'

type Stream = any

export interface BaseProtocolError {
  code: string
  message: string
  data?: any
}

export type ProtocolRPCPayload = unknown
export type ProtocolRPCResponse = unknown

export type EncodeRPCStreams = Record<number, ProtocolBlobMetadata>

export interface DecodeRPCContext<T = Stream> {
  addStream: (id: number, metadata: ProtocolBlobMetadata) => T
}
