import { deserialize, serialize } from 'node:v8'

import type { Pattern } from '@nmtjs/core'
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

  encode(data: any): ArrayBuffer {
    return serialize(data).buffer as ArrayBuffer
  }

  encodeRPC(rpc: ProtocolRPCResponse, _context: EncodeRPCContext): ArrayBuffer {
    return this.encode(rpc)
  }

  decode(buffer: ArrayBuffer): any {
    return deserialize(Buffer.from(buffer) as any)
  }

  decodeRPC(buffer: ArrayBuffer, _context: DecodeRPCContext): ProtocolRPC {
    const [callId, procedure, payload] = this.decode(buffer)
    return { callId, procedure, payload }
  }
}

export const testLogger = () =>
  createLogger({ pinoOptions: { enabled: false } }, 'test')

export const testFormat = () => new TestFormat()
