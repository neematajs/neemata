import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolBlobInterface,
} from '../common/index.ts'
import { concat, decodeNumber, encodeNumber } from '../common/index.ts'
import { BaseServerCodec } from '../server/codec.ts'
import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

export class JsonCodec extends BaseServerCodec {
  contentType = 'application/json'
  accept = ['application/json']

  encode(data: any) {
    // Encoding undefined would produce a zero-byte frame that gets silently
    // dropped over SSE and breaks decoding over WS — reject it early instead
    if (typeof data === 'undefined') {
      throw new TypeError('Cannot encode undefined')
    }
    return Buffer.from(JSON.stringify(data), 'utf-8')
  }

  encodeBlob(streamId: number) {
    return serializeStreamId(streamId)
  }

  encodeRPC(data: unknown, streams: EncodeRPCStreams) {
    const buffers: (ArrayBufferView | ArrayBuffer)[] = []
    const hasStreams = Object.keys(streams).length > 0
    if (hasStreams) {
      const metadata = this.encode(streams)
      buffers.push(encodeNumber(metadata.byteLength, 'Uint32'), metadata)
    } else {
      buffers.push(encodeNumber(0, 'Uint32'))
    }

    if (typeof data !== 'undefined') {
      buffers.push(this.encode(data))
    }

    return concat(...buffers)
  }

  decode(data: Buffer, _reviver?: (key: string, value: any) => any) {
    return JSON.parse(data.toString('utf-8'), _reviver)
  }

  decodeRPC(buffer: Buffer, context: DecodeRPCContext<ProtocolBlobInterface>) {
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
