import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolBlobInterface,
} from '@nmtjs/protocol'
import {
  concat,
  decodeNumber,
  encodeNumber,
  isBlobInterface,
} from '@nmtjs/protocol'
import { BaseServerFormat } from '@nmtjs/protocol/server'

import {
  createStreamReviver,
  escapeStreamLikeString,
  needsEscaping,
  serializeStreamId,
} from './common.ts'

// Stream refs arrive here as strings already minted by ProtocolBlob.toJSON
// (toJSON runs before the replacer) — the pre-toJSON holder value tells them
// apart from user data that merely looks like a ref, which must be escaped
// so it can't be misread as one on decode.
function escapeReplacer(this: any, key: string, value: any) {
  if (typeof value === 'string' && needsEscaping(value)) {
    if (isBlobInterface(this?.[key])) return value
    return escapeStreamLikeString(value)
  }
  return value
}

export class JsonFormat extends BaseServerFormat {
  contentType = 'application/json'
  accept = ['application/json']

  encode(data: any, _replacer?: (key: string, value: any) => any) {
    // Encoding undefined would produce a zero-byte frame that gets silently
    // dropped over SSE and breaks decoding over WS — reject it early instead
    if (typeof data === 'undefined') {
      throw new TypeError('Cannot encode undefined')
    }
    return Buffer.from(JSON.stringify(data, _replacer), 'utf-8')
  }

  encodeBlob(streamId: number) {
    return serializeStreamId(streamId)
  }

  encodeRPC(data: unknown, streams: EncodeRPCStreams) {
    const buffers: (ArrayBufferView | ArrayBuffer)[] = []
    const hasStreams = Object.keys(streams).length > 0
    if (hasStreams) {
      const encodedStreams = this.encode(streams)
      buffers.push(
        encodeNumber(encodedStreams.byteLength, 'Uint32'),
        encodedStreams,
      )
    } else {
      buffers.push(encodeNumber(0, 'Uint32'))
    }

    if (typeof data !== 'undefined') {
      buffers.push(this.encode(data, escapeReplacer))
    }

    return concat(...buffers)
  }

  decode(data: Buffer, _reviver?: (key: string, value: any) => any) {
    return JSON.parse(data.toString('utf-8'), _reviver)
  }

  decodeRPC(buffer: Buffer, context: DecodeRPCContext<ProtocolBlobInterface>) {
    const streamsLength = Number(decodeNumber(buffer, 'Uint32'))
    const hasStreams = streamsLength > 0
    const payloadBuffer = buffer.subarray(
      Uint32Array.BYTES_PER_ELEMENT + streamsLength,
    )
    const hasPayload = payloadBuffer.byteLength > 0

    let streams: EncodeRPCStreams = {}

    if (hasStreams) {
      streams = this.decode(
        buffer.subarray(
          Uint32Array.BYTES_PER_ELEMENT,
          Uint32Array.BYTES_PER_ELEMENT + streamsLength,
        ),
      )
    }

    if (!hasPayload) return undefined
    // the reviver also unescapes stream-like user strings, so it applies even
    // when no streams are declared
    return this.decode(
      payloadBuffer,
      createStreamReviver(streams, (id, metadata) =>
        context.addStream(id, metadata),
      ),
    )
  }
}
