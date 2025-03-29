import type { ProtocolServerBlobStream } from '../client/stream.ts'
import type {
  ProtocolBlob,
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from './blob.ts'

export type ProtocolRPC = {
  callId: number
  namespace: string
  procedure: string
  payload: any
}

export type ProtocolRPCResponse =
  | {
      callId: number
      error: any
      payload?: never
    }
  | {
      callId: number
      payload: any
      error?: never
    }

export interface EncodeRPCContext {
  getStream: (id: number) => any
  addStream: (blob: ProtocolBlob) => {
    id: number
    metadata: ProtocolBlobMetadata
  }
}

export interface DecodeRPCContext {
  getStream: (id: number) => any
  addStream: (id: number, metadata: ProtocolBlobMetadata) => any
}

export interface BaseClientDecoder {
  decode(buffer: ArrayBuffer): any
  decodeRPC(buffer: ArrayBuffer, context: DecodeRPCContext): ProtocolRPCResponse
}

export interface BaseClientEncoder {
  encode(data: any): ArrayBuffer
  encodeRPC(rpc: ProtocolRPC, context: EncodeRPCContext): ArrayBuffer
}

export type InputType<T> = T extends any[]
  ? InputType<T[number]>[]
  : T extends ProtocolBlobInterface
    ? ProtocolBlob
    : T extends object
      ? { [K in keyof T]: InputType<T[K]> }
      : T

export type OutputType<T> = T extends any[]
  ? OutputType<T[number]>[]
  : T extends ProtocolBlobInterface
    ? ProtocolServerBlobStream
    : T extends object
      ? { [K in keyof T]: OutputType<T[K]> }
      : T
