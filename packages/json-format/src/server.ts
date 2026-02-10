import type { DecodeRPCContext, EncodeRPCStreams } from '@nmtjs/protocol'
import type { ProtocolClientStream } from '@nmtjs/protocol/server'
import { concat, decodeNumber, encodeNumber } from '@nmtjs/protocol'
import { BaseServerFormat } from '@nmtjs/protocol/server'

import { deserializeStreamId, isStreamId, serializeStreamId } from './common.ts'

export class JsonFormat extends BaseServerFormat {
  contentType = 'application/json'
  accept = ['application/json']

  encode(data: any) {
    return typeof data !== 'undefined'
      ? Buffer.from(JSON.stringify(data), 'utf-8')
      : Buffer.alloc(0)
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
      buffers.push(this.encode(data))
    }

    return concat(...buffers)
  }

  decode(data: Buffer, _reviver?: (key: string, value: any) => any) {
    return JSON.parse(data.toString('utf-8'), _reviver)
  }

  decodeRPC(
    buffer: Buffer,
    context: DecodeRPCContext<() => ProtocolClientStream>,
  ) {
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

    const replacer = (_key: string, value: any) => {
      if (typeof value === 'string' && isStreamId(value)) {
        const id = deserializeStreamId(value)
        const metadata = streams[id]
        return context.addStream(id, metadata)
      }
      return value
    }

    if (!hasPayload) return undefined
    else if (hasStreams) return this.decode(payloadBuffer, replacer)
    else return this.decode(payloadBuffer)
  }
}
