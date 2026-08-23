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
import {
  assertStreamsMetadata,
  createStreamReviver,
  escapeStreamLikeString,
  mayContainStreamLikeJson,
  needsEscaping,
  serializeStreamId,
} from './common.ts'

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

    let payloadBuffer: ArrayBufferView | undefined
    let streamsBuffer: ArrayBufferView

    function _replacer(_key: string, value: any) {
      if (value instanceof ProtocolBlob) {
        hasStreams = true
        const stream = context.addStream(value)
        streams[stream.id] = stream.metadata
        return serializeStreamId(stream.id)
      }
      if (typeof value === 'string' && needsEscaping(value)) {
        return escapeStreamLikeString(value)
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
    context: DecodeRPCContext<ProtocolBlobInterface>,
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
      ? assertStreamsMetadata(
          this.decode(
            buffer.subarray(
              Uint32Array.BYTES_PER_ELEMENT,
              Uint32Array.BYTES_PER_ELEMENT + streamsLength,
            ),
          ),
        )
      : {}

    if (!hasPayload) return undefined
    if (!mayContainStreamLikeJson(payloadBuffer)) {
      return this.decode(payloadBuffer)
    }
    return this.decode(
      payloadBuffer,
      createStreamReviver(streams, (id, metadata) =>
        context.addStream(id, metadata),
      ),
    )
  }
}
