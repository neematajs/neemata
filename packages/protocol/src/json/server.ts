import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolBlobInterface,
} from '../common/index.ts'
import { BaseServerCodec } from '../server/codec.ts'
import { decodeRPCFrame, frameRPC, serializeStreamId } from './common.ts'

export class JsonCodec extends BaseServerCodec {
  contentType = 'application/json'
  accept = ['application/json']

  encode(data: any) {
    // Encoding undefined would produce a zero-byte frame that gets silently
    // dropped over SSE and breaks decoding over WS — reject it early instead
    if (data === undefined) {
      throw new TypeError('Cannot encode undefined')
    }
    return Buffer.from(JSON.stringify(data), 'utf-8')
  }

  encodeBlob(streamId: number) {
    return serializeStreamId(streamId)
  }

  encodeRPC(data: unknown, streams: EncodeRPCStreams) {
    const metadata = Object.keys(streams).length
      ? this.encode(streams)
      : undefined
    const payload = data === undefined ? undefined : this.encode(data)

    return frameRPC(metadata, payload)
  }

  decode(data: Buffer, reviver?: (key: string, value: any) => any) {
    return JSON.parse(data.toString('utf-8'), reviver)
  }

  decodeRPC(buffer: Buffer, context: DecodeRPCContext<ProtocolBlobInterface>) {
    return decodeRPCFrame(
      buffer,
      (payload, reviver) => this.decode(payload, reviver),
      context,
    )
  }
}
