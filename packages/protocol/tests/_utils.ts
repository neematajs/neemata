import { Buffer } from 'node:buffer'
import { deserialize, serialize } from 'node:v8'

import type { Pattern } from '@nmtjs/common'
import { createLogger } from '@nmtjs/core'

import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../src/common/blob.ts'
import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolRPCPayload,
} from '../src/common/types.ts'
import { BaseServerCodec } from '../src/server/codec.ts'

export class TestCodec extends BaseServerCodec {
  accept: Pattern[] = [
    'application/test',
    '*es*',
    '*test',
    'application/test*',
    (t) => t === 'application/test',
    /test/,
  ]
  contentType = 'application/test'

  encode(data: any): ArrayBufferView {
    return serialize(data) as ArrayBufferView
  }

  encodeRPC(
    data: ProtocolRPCPayload,
    _streams: EncodeRPCStreams,
  ): ArrayBufferView {
    return this.encode(data)
  }

  encodeBlob(streamId: number, metadata: ProtocolBlobMetadata) {
    return { streamId, metadata }
  }

  decode(buffer: ArrayBufferView): any {
    const view = Buffer.from(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    )
    return deserialize(view)
  }

  decodeRPC(
    buffer: ArrayBufferView,
    _context: DecodeRPCContext<ProtocolBlobInterface>,
  ): ProtocolRPCPayload {
    return this.decode(buffer)
  }
}

export const testLogger = () =>
  createLogger({ pinoOptions: { enabled: false } }, 'test')

export const testCodec = () => new TestCodec()
