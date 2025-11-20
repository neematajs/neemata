import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPCResponse,
} from '@nmtjs/protocol'
import { ProtocolBlob } from '@nmtjs/protocol'
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

  encode(data: any) {
    return Buffer.from(JSON.stringify(data), 'utf-8')
  }

  encodeRPC(rpc: ProtocolRPCResponse, context: EncodeRPCContext) {
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

  decode(data: Buffer) {
    return JSON.parse(data.toString('utf-8'))
  }

  decodeRPC(buffer: Buffer, context: DecodeRPCContext) {
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
    return Buffer.from(JSON.stringify(data), 'utf-8')
  }

  encodeRPC(rpc: ProtocolRPCResponse) {
    const { callId, error } = rpc
    if (error) return this.encode([callId, error, null])
    else {
      return this.encode([callId, null, rpc.result])
    }
  }

  decode(buffer: Buffer) {
    return JSON.parse(buffer.toString('utf-8'))
  }

  decodeRPC(buffer: Buffer) {
    const [callId, procedure, payload]: ClientEncodedRPC = this.decode(buffer)
    return { callId, procedure, payload }
  }
}
