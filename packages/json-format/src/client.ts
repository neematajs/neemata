// ./ <reference lib="dom" />

import type { DecodeRPCContext, EncodeRPCStreams } from '@nmtjs/protocol'
import type {
  EncodeRPCContext,
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
} from '@nmtjs/protocol/client'
import {
  concat,
  decodeNumber,
  decodeText,
  encodeNumber,
  encodeText,
  ProtocolBlob,
} from '@nmtjs/protocol'
import { BaseClientFormat } from '@nmtjs/protocol/client'

import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

/**
 * Custom JSON encoding format with support for Neemata streams.
 */
export class JsonFormat extends BaseClientFormat {
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

    let payloadBuffer: ArrayBufferView | undefined
    let streamsBuffer: ArrayBufferView

    function _replacer(_key: string, value: any) {
      if (value instanceof ProtocolBlob) {
        hasStreams = true
        const stream = context.addStream(value)
        streams[stream.id] = stream.metadata
        return serializeStreamId(stream.id)
      }
      return value
    }

    if (typeof data !== 'undefined') {
      payloadBuffer = this.encode(data, _replacer)
    }

    if (hasStreams) {
      streamsBuffer = this.encode(streams)
      buffers.push(
        encodeNumber(streamsBuffer.byteLength, 'Uint32'),
        streamsBuffer,
      )
    } else {
      buffers.push(encodeNumber(0, 'Uint32'))
    }

    if (typeof payloadBuffer !== 'undefined') {
      buffers.push(payloadBuffer)
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
    _buffer: ArrayBufferView,
    context: DecodeRPCContext<
      (options?: { signal?: AbortSignal }) => ProtocolServerBlobStream
    >,
  ) {
    const buffer = new Uint8Array(
      _buffer.buffer,
      _buffer.byteOffset,
      _buffer.byteLength,
    )
    const streamsLength = Number(decodeNumber(buffer, 'Uint32'))
    const hasStreams = streamsLength > 0
    const payloadBuffer = buffer.subarray(
      Uint32Array.BYTES_PER_ELEMENT + streamsLength,
    )
    const hasPayload = payloadBuffer.byteLength > 0

    const streams = hasStreams
      ? (this.decode(
          buffer.subarray(
            Uint32Array.BYTES_PER_ELEMENT,
            Uint32Array.BYTES_PER_ELEMENT + streamsLength,
          ),
        ) as EncodeRPCStreams)
      : {}

    const replacer = (_key: string, value: any) => {
      if (typeof value === 'string' && isStreamId(value)) {
        const id = deserializeStreamId(value)
        const metadata = streams[id]
        return context.addStream(id, metadata)
      }
      return value
    }

    if (typeof hasPayload === 'undefined') return undefined
    else if (hasStreams) return this.decode(payloadBuffer, replacer)
    else return this.decode(payloadBuffer)
  }
}
