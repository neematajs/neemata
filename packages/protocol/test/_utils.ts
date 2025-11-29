import { deserialize, serialize } from 'node:v8'

import type { Pattern } from '@nmtjs/common'
import { createLogger } from '@nmtjs/core'

import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPC,
  ProtocolRPCResponse,
} from '../src/common/types.ts'
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
    rpc: ProtocolRPCResponse,
    _context: EncodeRPCContext,
  ): ArrayBufferView {
    return this.encode(rpc)
  }

  decode(buffer: ArrayBufferView): any {
    return deserialize(Buffer.from(buffer.buffer))
  }

  decodeRPC(buffer: ArrayBufferView, _context: DecodeRPCContext): ProtocolRPC {
    const [callId, procedure, payload] = this.decode(buffer)
    return { callId, procedure, payload }
  }
}

export const testLogger = () =>
  createLogger({ pinoOptions: { enabled: false } }, 'test')

export const testFormat = () => new TestFormat()
