import type { DecodeRPCContext, EncodeRPCContext } from '@nmtjs/protocol'
import type { ProtocolServerBlobStream } from '@nmtjs/protocol/client'
import { decodeText, encodeText, ProtocolBlob } from '@nmtjs/protocol'
import { BaseClientFormat } from '@nmtjs/protocol/client'

import type {
  ClientEncodedRPC,
  ServerEncodedRPC,
  StreamsMetadata,
} from './common.ts'
import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

/**
 * Custom JSON encoding format with support for Neemata streams.
 */
export class JsonFormat extends BaseClientFormat {
  contentType = 'application/x-neemata-json'

  encode(data: any): ArrayBufferView {
    return encodeText(JSON.stringify(data))
  }

  encodeRPC(data: unknown, context: EncodeRPCContext) {
    // const streamsMetadata: StreamsMetadata = {}
    const streams: StreamsMetadata = {}
    const replacer = (_key: string, value: any) => {
      if (value instanceof ProtocolBlob) {
        const stream = context.addStream(value)
        streams[stream.id] = stream.metadata
        return serializeStreamId(stream.id)
      }
      return value
    }
    const payload =
      typeof data === 'undefined' ? undefined : JSON.stringify(data, replacer)

    const buffer =
      typeof payload === 'undefined'
        ? this.encode([streams] satisfies ClientEncodedRPC)
        : this.encode([streams, payload] satisfies ClientEncodedRPC)

    return buffer
  }

  decode(data: ArrayBufferView): any {
    return JSON.parse(decodeText(data))
  }

  decodeRPC(buffer: ArrayBufferView, context: DecodeRPCContext) {
    const streams: Record<number, ProtocolServerBlobStream> = {}
    const [streamsMetadata, payload]: ServerEncodedRPC = this.decode(buffer)
    const replacer = (_key: string, value: any) => {
      if (typeof value === 'string' && isStreamId(value)) {
        const id = deserializeStreamId(value)
        const metadata = streamsMetadata[id]
        const stream = context.addStream(id, metadata)
        streams[id] = stream
        return stream
      }
      return value
    }
    const decoded =
      typeof payload === 'undefined' ? undefined : JSON.parse(payload, replacer)

    return decoded
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

  encodeRPC(data: unknown) {
    const buffer = this.encode(data)
    return buffer
  }

  decode(data: ArrayBufferView) {
    return JSON.parse(decodeText(data))
  }

  decodeRPC(buffer: ArrayBufferView) {
    return this.decode(buffer)
  }
}
