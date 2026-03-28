import type { ProtocolBlobMetadata } from './blob.ts'

export interface BaseProtocolError {
  code: string
  message: string
  data?: any
}

export type ProtocolRPCPayload = unknown
export type ProtocolRPCResponse = unknown

export type EncodeRPCStreams = Record<number, ProtocolBlobMetadata>

export interface DecodeRPCContext<T = unknown> {
  addStream: (id: number, metadata: ProtocolBlobMetadata) => T
}
