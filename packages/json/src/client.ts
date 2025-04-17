import { BaseClientFormat } from '@nmtjs/protocol/client'
import {
  type DecodeRPCContext,
  decodeText,
  type EncodeRPCContext,
  encodeText,
  ProtocolBlob,
  type ProtocolBlobMetadata,
  type ProtocolRPC,
} from '@nmtjs/protocol/common'
import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

/**
 * Custom JSON encoding format with support for Neemata streams.
 */
export class JsonFormat extends BaseClientFormat {
  contentType = 'application/x-neemata-json'

  encode(data: any): ArrayBuffer {
    return encodeText(JSON.stringify(data))
  }

  encodeRPC(rpc: ProtocolRPC, context: EncodeRPCContext): ArrayBuffer {
    const { callId, namespace, procedure } = rpc
    const streams: Record<number, ProtocolBlobMetadata> = {}
    const replacer = (key: string, value: any) => {
      if (value instanceof ProtocolBlob) {
        const stream = context.addStream(value)
        streams[stream.id] = stream.metadata
        return serializeStreamId(stream.id)
      }
      return value
    }
    const payload = JSON.stringify(rpc.payload, replacer)
    return this.encode([callId, namespace, procedure, streams, payload])
  }

  decode(data: ArrayBuffer): any {
    return JSON.parse(decodeText(data))
  }

  decodeRPC(buffer: ArrayBuffer, context: DecodeRPCContext) {
    const [callId, error, streams, formatPayload] = this.decode(buffer)
    if (error) return { callId, error, payload: null }
    else {
      const replacer = (key: string, value: any) => {
        if (typeof value === 'string' && isStreamId(value)) {
          const id = deserializeStreamId(value)
          const metadata = streams[id]
          return context.addStream(id, metadata)
        }
        return value
      }
      const payload = formatPayload ? JSON.parse(formatPayload, replacer) : null
      return { callId, error: null, payload }
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
    return this.encode([callId, namespace, procedure, payload])
  }

  decode(data: ArrayBuffer) {
    return JSON.parse(decodeText(data))
  }

  decodeRPC(buffer: ArrayBuffer) {
    const [callId, error, payload] = this.decode(buffer)
    return { callId, error, payload }
  }
}
