import {
  type DecodeRpcContext,
  decodeNumber,
  decodeText,
  encodeText,
} from '@neematajs/common'
import { BaseServerFormat } from '@neematajs/common'
import { deserializeStreamId, isStreamId } from './common'

export class JsonFormat extends BaseServerFormat {
  accepts = ['application/json']
  mime = 'application/json'

  encode(
    data: any,
    replacer?: (this: any, key: string, value: any) => any,
  ): ArrayBuffer {
    return encodeText(JSON.stringify(data, replacer))
  }

  decode(
    data: ArrayBuffer,
    replacer?: (this: any, key: string, value: any) => any,
  ): any {
    return JSON.parse(decodeText(data), replacer)
  }

  decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): any {
    const streams = this.parseRPCStreams(buffer, context)
    const data = this.parseRPCMessageData(
      buffer.slice(Uint32Array.BYTES_PER_ELEMENT + streams.length),
      streams.replacer,
    )
    return data
  }

  protected parseRPCStreams(buffer: ArrayBuffer, context: DecodeRpcContext) {
    const length = decodeNumber(buffer, 'Uint32')
    const streams = this.decode(
      buffer.slice(
        Uint32Array.BYTES_PER_ELEMENT,
        Uint32Array.BYTES_PER_ELEMENT + length,
      ),
    )

    const replacer = streams.length
      ? (key, value) => {
          if (isStreamId(value)) {
            const streamId = deserializeStreamId(value)
            return context.getStream(streamId)
          }
          return value
        }
      : undefined

    for (const [id, metadata] of streams) {
      context.addStream(id, metadata)
    }

    return { length, replacer }
  }

  protected parseRPCMessageData(
    buffer: ArrayBuffer,
    streamsJsonReplacer?: (...args: any[]) => any,
  ) {
    const [callId, name, payload] = this.decode(buffer, streamsJsonReplacer)
    return { callId, name, payload }
  }
}
