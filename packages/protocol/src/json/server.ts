import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolBlobInterface,
} from '../common/index.ts'
import {
  concat,
  decodeNumber,
  encodeNumber,
  isBlobInterface,
} from '../common/index.ts'
import { BaseServerCodec } from '../server/codec.ts'
import {
  assertStreamsMetadata,
  createStreamReviver,
  escapeStreamLikeString,
  mayContainStreamLikeJson,
  needsEscaping,
  serializeStreamId,
} from './common.ts'

function escapeReplacer(this: any, key: string, value: any) {
  if (typeof value === 'string' && needsEscaping(value)) {
    // ProtocolBlob.toJSON runs before the replacer; the holder distinguishes
    // its real stream reference from indistinguishable user data.
    if (isBlobInterface(this?.[key])) return value
    return escapeStreamLikeString(value)
  }
  return value
}

export class JsonCodec extends BaseServerCodec {
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
      if (hasStreams) {
        buffers.push(this.encode(data, escapeReplacer))
      } else {
        // Ordinary payloads avoid replacer overhead; suspicious output is
        // encoded again so the holder can distinguish real refs from data.
        const encoded = this.encode(data)
        buffers.push(
          mayContainStreamLikeJson(encoded)
            ? this.encode(data, escapeReplacer)
            : encoded,
        )
      }
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
      streams = assertStreamsMetadata(
        this.decode(
          buffer.subarray(
            Uint32Array.BYTES_PER_ELEMENT,
            Uint32Array.BYTES_PER_ELEMENT + streamsLength,
          ),
        ),
      )
    }

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
