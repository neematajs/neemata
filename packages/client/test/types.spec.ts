import type { OneOf } from '@nmtjs/common'
import type { ClientMessageType } from '@nmtjs/protocol'
import type {
  ProtocolBaseClientCallOptions,
  ProtocolBaseTransformer,
  ProtocolError,
  ProtocolSendMetadata,
  ProtocolServerStreamInterface,
} from '@nmtjs/protocol/client'
import { c } from '@nmtjs/contract'
import { ProtocolTransport } from '@nmtjs/protocol/client'
import { t } from '@nmtjs/type'
import { describe, expectTypeOf, it } from 'vitest'

import { RuntimeClient } from '../src/runtime.ts'

class MockTransport extends ProtocolTransport {
  async connect(
    _auth: any,
    _transformer: ProtocolBaseTransformer,
  ): Promise<void> {}
  async disconnect(): Promise<void> {}
  async call(_procedure: string, payload: any): Promise<any> {
    return payload
  }
  async send(
    _messageType: ClientMessageType,
    _buffer: ArrayBuffer,
    _metadata: ProtocolSendMetadata,
  ): Promise<void> {}
}

describe('Types', () => {
  const simpleProcedure = c.procedure({ input: t.string(), output: t.string() })

  const streamProcedure = c.procedure({
    input: t.string(),
    output: t.string(),
    stream: t.string(),
  })

  const nestedRouter1 = c.router({ routes: { simple: simpleProcedure } })

  const nestedRouter2 = c.router({
    routes: { simple: simpleProcedure, nestedRouter1 },
  })

  const router = c.router({
    routes: {
      simple: simpleProcedure,
      simpleInline: c.procedure({ input: t.string(), output: t.string() }),
      stream: streamProcedure,
      nested: nestedRouter2,
    },
  })

  const api = c.api({ router })

  describe('Unsafe client', () => {
    const client = new RuntimeClient(api, new MockTransport(), {
      safe: false,
      timeout: 1,
    })

    it('should properly resolve types', () => {
      expectTypeOf(client._?.api.routes.simple.input).toEqualTypeOf<string>()
      expectTypeOf(client._?.api.routes.simple.output).toEqualTypeOf<string>()
      expectTypeOf(
        client._?.api.routes.nested.routes.simple.input,
      ).toEqualTypeOf<string>()
      expectTypeOf(
        client._?.api.routes.nested.routes.simple.output,
      ).toEqualTypeOf<string>()
      expectTypeOf(
        client._?.api.routes.nested.routes.nestedRouter1.routes.simple.input,
      ).toEqualTypeOf<string>()
      expectTypeOf(
        client._?.api.routes.nested.routes.nestedRouter1.routes.simple.output,
      ).toEqualTypeOf<string>()
    })

    it('should properly resolve call types', () => {
      type Response = (
        data: string,
        options?: Partial<ProtocolBaseClientCallOptions> | undefined,
      ) => Promise<string>

      expectTypeOf(client.call.simple).toEqualTypeOf<Response>()
      expectTypeOf(client.call.simpleInline).toEqualTypeOf<Response>()
      expectTypeOf(client.call.stream).toEqualTypeOf<
        (
          data: string,
          options?: Partial<ProtocolBaseClientCallOptions> | undefined,
        ) => Promise<{
          result: string
          stream: ProtocolServerStreamInterface<string>
        }>
      >()
      expectTypeOf(client.call.nested.simple).toEqualTypeOf<Response>()
      expectTypeOf(
        client.call.nested.nestedRouter1.simple,
      ).toEqualTypeOf<Response>()
    })
  })

  describe('Safe client', () => {
    const client = new RuntimeClient(api, new MockTransport(), {
      safe: true,
      timeout: 1,
    })

    it('should properly resolve types', () => {
      expectTypeOf(client._?.api.routes.simple.input).toEqualTypeOf<string>()
      expectTypeOf(client._?.api.routes.simple.output).toEqualTypeOf<string>()
    })

    it('should properly resolve call types', () => {
      type Response = (
        data: string,
        options?: Partial<ProtocolBaseClientCallOptions> | undefined,
      ) => Promise<OneOf<[{ output: string }, { error: ProtocolError }]>>

      expectTypeOf(client.call.simple).toEqualTypeOf<Response>()
      expectTypeOf(client.call.simpleInline).toEqualTypeOf<Response>()
      expectTypeOf(client.call.stream).toEqualTypeOf<
        (
          data: string,
          options?: Partial<ProtocolBaseClientCallOptions> | undefined,
        ) => Promise<
          OneOf<
            [
              {
                output: {
                  result: string
                  stream: ProtocolServerStreamInterface<string>
                }
              },
              { error: ProtocolError },
            ]
          >
        >
      >()
      expectTypeOf(client.call.nested.simple).toEqualTypeOf<Response>()
      expectTypeOf(
        client.call.nested.nestedRouter1.simple,
      ).toEqualTypeOf<Response>()
    })
  })
})
