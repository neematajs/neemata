import type { ProtocolBlob, ProtocolBlobMetadata } from './blob.ts'

type Stream = any

export interface BaseProtocolError {
  code: string
  message: string
  data?: any
}

export type ProtocolRPC = {
  callId: number
  procedure: string
  payload: unknown
}

export type ProtocolRPCResponse<T = Stream> = {
  result: any
  streams: Record<number, T>
}

export interface EncodeRPCContext<T = Stream> {
  getStream: (id: number) => T
  addStream: (blob: ProtocolBlob) => T
}

export interface DecodeRPCContext<T = Stream> {
  getStream: (id: number) => T
  addStream: (id: number, metadata: ProtocolBlobMetadata) => T
}
