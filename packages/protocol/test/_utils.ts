import { Buffer } from 'node:buffer'
import { deserialize, serialize } from 'node:v8'

import type { Pattern } from '@nmtjs/common'
import { createLogger } from '@nmtjs/core'

import type { ProtocolBlobMetadata } from '../src/common/blob.ts'
import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolRPCPayload,
} from '../src/common/types.ts'
import type { ProtocolClientStream } from '../src/server/stream.ts'
import { BaseServerFormat } from '../src/server/format.ts'

export class TestFormat extends BaseServerFormat {
  accept: Pattern[] = [
    'test',
    '*es*',
    '*test',
    'test*',
    (t) => t === 'test',
    /test/,
  ]
  contentType = 'test'

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
    _context: DecodeRPCContext<() => ProtocolClientStream>,
  ): ProtocolRPCPayload {
    return this.decode(buffer)
  }
}

export const testLogger = () =>
  createLogger({ pinoOptions: { enabled: false } }, 'test')

export const testFormat = () => new TestFormat()
