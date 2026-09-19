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
import { decodeText, encodeText, ProtocolBlob } from '../common/index.ts'
import { decodeRPCFrame, frameRPC, serializeStreamId } from './common.ts'

/**
 * JSON codec with support for Neemata streams.
 */
export class JsonCodec extends BaseClientCodec {
  contentType = 'application/json'

  encode(
    data: any,
    replacer?: (key: string, value: any) => any,
  ): ArrayBufferView {
    return encodeText(JSON.stringify(data, replacer))
  }

  encodeRPC(
    data: unknown,
    context: EncodeRPCContext<ProtocolClientBlobStream>,
  ) {
    const streams: EncodeRPCStreams = {}

    function replacer(_key: string, value: unknown) {
      if (value instanceof ProtocolBlob) {
        const stream = context.addStream(value)
        streams[stream.id] = stream.metadata
        return serializeStreamId(stream.id)
      }
      return value
    }

    const payload = data === undefined ? undefined : this.encode(data, replacer)
    // the replacer fills `streams` while the payload is stringified
    const metadata = Object.keys(streams).length
      ? this.encode(streams)
      : undefined

    return frameRPC(metadata, payload)
  }

  decode(data: ArrayBufferView, reviver?: (key: string, value: any) => any) {
    return JSON.parse(decodeText(data), reviver)
  }

  decodeRPC(
    data: ArrayBufferView,
    context: DecodeRPCContext<ProtocolBlobInterface>,
  ) {
    const buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return decodeRPCFrame(
      buffer,
      (payload, reviver) => this.decode(payload, reviver),
      context,
    )
  }
}
