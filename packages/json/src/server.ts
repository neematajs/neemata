import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPCResponse,
} from '@nmtjs/protocol'
import { decodeText, encodeText, ProtocolBlob } from '@nmtjs/protocol'
import { BaseServerFormat } from '@nmtjs/protocol/server'

import type {
  ClientEncodedRPC,
  ServerEncodedRPC,
  StreamsMetadata,
} from './common.ts'
import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

/**
 * Custom JSON encoding format with Neemata streams support.
 */
export class JsonFormat extends BaseServerFormat {
  contentType = 'application/x-neemata-json'
  accept = ['application/x-neemata-json']

  encode(data: any): ArrayBuffer {
    return encodeText(JSON.stringify(data))
  }

  encodeRPC(rpc: ProtocolRPCResponse, context: EncodeRPCContext): ArrayBuffer {
    const { callId, error } = rpc
    if (error) return this.encode([callId, error] satisfies ServerEncodedRPC)
    else {
      const streams: StreamsMetadata = {}
      const replacer = (_key: string, value: any) => {
        if (value instanceof ProtocolBlob) {
          const stream = context.addStream(value)
          streams[stream.id] = stream.metadata
          return serializeStreamId(stream.id)
        }
        return value
      }
      const isUndefined = typeof rpc.result === 'undefined'
      const payload = JSON.stringify(rpc.result, replacer)
      return this.encode(
        isUndefined
          ? ([callId, null, streams] satisfies ServerEncodedRPC)
          : ([callId, null, streams, payload] satisfies ServerEncodedRPC),
      )
    }
  }

  decode(data: ArrayBuffer) {
    return JSON.parse(decodeText(data))
  }

  decodeRPC(buffer: ArrayBuffer, context: DecodeRPCContext) {
    const [callId, procedure, streams, formatPayload]: ClientEncodedRPC =
      this.decode(buffer)

    const replacer = (_key: string, value: any) => {
      if (typeof value === 'string' && isStreamId(value)) {
        const id = deserializeStreamId(value)
        const metadata = streams[id]
        return context.addStream(id, callId, metadata)
      }
      return value
    }

    const payload =
      typeof formatPayload === 'undefined'
        ? undefined
        : JSON.parse(formatPayload, replacer)

    return { callId, procedure, payload }
  }
}

/**
 * Standard JSON encoding format with no Neemata streams support.
 */
export class StandardJsonFormat extends BaseServerFormat {
  contentType = 'application/json'
  accept = ['application/json', 'application/vnd.api+json']

  encode(data: any) {
    return encodeText(JSON.stringify(data))
  }

  encodeRPC(rpc: ProtocolRPCResponse) {
    const { callId, error } = rpc
    if (error) return this.encode([callId, error, null])
    else {
      return this.encode([callId, null, rpc.result])
    }
  }

  decode(buffer: ArrayBuffer) {
    return JSON.parse(decodeText(buffer))
  }

  decodeRPC(buffer: ArrayBuffer) {
    const [callId, procedure, payload]: ClientEncodedRPC = this.decode(buffer)
    return { callId, procedure, payload }
  }
}
