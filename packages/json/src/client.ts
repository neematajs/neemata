import {
  type DecodeRPCContext,
  decodeText,
  type EncodeRPCContext,
  encodeText,
  ProtocolBlob,
  type ProtocolBlobMetadata,
  type ProtocolRPC,
} from '@nmtjs/protocol'
import {
  BaseClientFormat,
  type ProtocolClientBlobStream,
  type ProtocolServerBlobStream,
} from '@nmtjs/protocol/client'
import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

/**
 * Custom JSON encoding format with support for Neemata streams.
 */
export class JsonFormat extends BaseClientFormat {
  contentType = 'application/x-neemata-json'

  encode(data: any): ArrayBuffer {
    return encodeText(JSON.stringify(data))
  }

  encodeRPC(rpc: ProtocolRPC, context: EncodeRPCContext) {
    const { callId, namespace, procedure } = rpc
    const streamsMetadata: Record<number, ProtocolBlobMetadata> = {}
    const streams: Record<number, ProtocolClientBlobStream> = {}
    const replacer = (key: string, value: any) => {
      if (value instanceof ProtocolBlob) {
        const stream = context.addStream(value)
        streamsMetadata[stream.id] = stream.metadata
        streams[stream.id] = stream
        return serializeStreamId(stream.id)
      }
      return value
    }
    const payload = JSON.stringify(rpc.payload, replacer)
    const buffer = this.encode([
      callId,
      namespace,
      procedure,
      streamsMetadata,
      payload,
    ])
    return { buffer, streams }
  }

  decode(data: ArrayBuffer): any {
    return JSON.parse(decodeText(data))
  }

  decodeRPC(buffer: ArrayBuffer, context: DecodeRPCContext) {
    const streams: Record<number, ProtocolServerBlobStream> = {}
    const [callId, error, streamsMetadata, payload] = this.decode(buffer)
    if (error) return { callId, error }
    else {
      const replacer = (key: string, value: any) => {
        if (typeof value === 'string' && isStreamId(value)) {
          const id = deserializeStreamId(value)
          const metadata = streamsMetadata[id]
          const stream = context.addStream(id, callId, metadata)
          streams[id] = stream
          return stream
        }
        return value
      }
      const result =
        typeof payload === 'undefined'
          ? undefined
          : JSON.parse(payload, replacer)
      return { callId, result, streams }
    }
  }
}

/**
 * Standard JSON encoding format with no Neemata streams support.
 */
export class StandardJsonFormat extends BaseClientFormat {
  contentType = 'application/json'

  encode(data: any) {
    return encodeText(JSON.stringify(data))
  }

  encodeRPC(rpc: ProtocolRPC) {
    const { callId, namespace, procedure, payload } = rpc
    const streams: Record<number, ProtocolClientBlobStream> = {}
    const buffer = this.encode([callId, namespace, procedure, payload])
    return { buffer, streams }
  }

  decode(data: ArrayBuffer) {
    return JSON.parse(decodeText(data))
  }

  decodeRPC(buffer: ArrayBuffer) {
    const streams: Record<number, ProtocolServerBlobStream> = {}
    const [callId, error, result] = this.decode(buffer)
    if (error) return { callId, error }
    else return { callId, result, streams }
  }
}
