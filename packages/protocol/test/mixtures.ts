import { deserialize, serialize } from 'node:v8'
import type { Pattern } from '@nmtjs/core'
import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPC,
  ProtocolRPCResponse,
} from '../lib/common/types.ts'
import { BaseServerFormat } from '../lib/server/format.ts'

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

  encodeRPC(rpc: ProtocolRPCResponse, context: EncodeRPCContext): ArrayBuffer {
    return this.encode(rpc)
  }

  decode(buffer: ArrayBuffer): any {
    return deserialize(Buffer.from(buffer) as any)
  }

  decodeRPC(buffer: ArrayBuffer, context: DecodeRPCContext): ProtocolRPC {
    const [callId, namespace, procedure, payload] = this.decode(buffer)
    return { callId, namespace, procedure, payload }
  }
}
export const testFormat = () => new TestFormat()
