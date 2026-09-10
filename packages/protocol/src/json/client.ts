// ./ <reference lib="dom" />

import type {
  EncodeRPCContext,
  ProtocolClientBlobStream,
} from '../client/index.ts'
import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolBlobInterface,
} from '../common/index.ts'
import { BaseClientCodec } from '../client/codec.ts'
import {
  concat,
  decodeNumber,
  decodeText,
  encodeNumber,
  encodeText,
  ProtocolBlob,
} from '../common/index.ts'
import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

/**
 * JSON codec with support for Neemata streams.
 */
export class JsonCodec extends BaseClientCodec {
  contentType = 'application/json'

  encode(
    data: any,
    _replacer?: (key: string, value: any) => any,
  ): ArrayBufferView {
    return encodeText(JSON.stringify(data, _replacer))
  }

  encodeRPC(
    data: unknown,
    context: EncodeRPCContext<ProtocolClientBlobStream>,
  ) {
    const buffers: (ArrayBufferView | ArrayBuffer)[] = []
    const streams: EncodeRPCStreams = {}
    let hasStreams = false

    function replacer(_key: string, value: unknown) {
      if (value instanceof ProtocolBlob) {
        hasStreams = true
        const stream = context.addStream(value)
        streams[stream.id] = stream.metadata
        return serializeStreamId(stream.id)
      }
      return value
    }

    const payload =
      typeof data === 'undefined' ? undefined : this.encode(data, replacer)

    if (hasStreams) {
      const metadata = this.encode(streams)
      buffers.push(encodeNumber(metadata.byteLength, 'Uint32'), metadata)
    } else {
      buffers.push(encodeNumber(0, 'Uint32'))
    }

    if (typeof payload !== 'undefined') {
      buffers.push(payload)
    }

    return concat(...buffers)
  }

  decode(
    data: ArrayBufferView,
    _reviver?: (key: string, value: any) => any,
  ): any {
    return JSON.parse(decodeText(data), _reviver)
  }

  decodeRPC(
    data: ArrayBufferView,
    context: DecodeRPCContext<ProtocolBlobInterface>,
  ) {
    const buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const streamsLength = decodeNumber(buffer, 'Uint32')
    const hasStreams = streamsLength > 0
    const payloadOffset = Uint32Array.BYTES_PER_ELEMENT + streamsLength
    const payload = buffer.subarray(payloadOffset)

    let streams: EncodeRPCStreams = {}
    if (hasStreams) {
      const metadata = buffer.subarray(
        Uint32Array.BYTES_PER_ELEMENT,
        payloadOffset,
      )
      streams = this.decode(metadata)
    }

    if (payload.byteLength === 0) return undefined
    if (!hasStreams) return this.decode(payload)

    const reviver = (_key: string, value: unknown) => {
      if (typeof value === 'string' && isStreamId(value)) {
        const id = deserializeStreamId(value)
        const metadata = streams[id]
        return context.addStream(id, metadata)
      }
      return value
    }

    return this.decode(payload, reviver)
  }
}
