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
    auth: any,
    transformer: ProtocolBaseTransformer,
  ): Promise<void> {}
  async disconnect(): Promise<void> {}
  async call(namespace: string, procedure: string, payload: any): Promise<any> {
    return payload
  }
  async send(
    messageType: ClientMessageType,
    buffer: ArrayBuffer,
    metadata: ProtocolSendMetadata,
  ): Promise<void> {}
}

describe('Types', () => {
  const simpleProcedure = c.procedure({ input: t.string(), output: t.string() })

  const streamProcedure = c.procedure({
    input: t.string(),
    output: t.string(),
    stream: t.string(),
  })

  const namespace = c.namespace({
    procedures: {
      simple: simpleProcedure,
      simpleInline: c.procedure({ input: t.string(), output: t.string() }),
      stream: streamProcedure,
    },
    events: { test: c.event({ payload: t.string() }) },
  })

  const api = c.api({ namespaces: { test: namespace } })

  describe('Unsafe client', () => {
    const client = new RuntimeClient(api, new MockTransport(), {
      safe: false,
      timeout: 1,
    })

    it('should properly resolve types', () => {
      expectTypeOf(
        client._?.api.test.procedures.simple.input,
      ).toEqualTypeOf<string>()
      expectTypeOf(
        client._?.api.test.procedures.simple.output,
      ).toEqualTypeOf<string>()
    })

    it('should properly resolve call types', () => {
      type Response = (
        data: string,
        options?: Partial<ProtocolBaseClientCallOptions> | undefined,
      ) => Promise<string>

      expectTypeOf(client.call.test.simple).toEqualTypeOf<Response>()
      expectTypeOf(client.call.test.simpleInline).toEqualTypeOf<Response>()
      expectTypeOf(client.call.test.stream).toEqualTypeOf<
        (
          data: string,
          options?: Partial<ProtocolBaseClientCallOptions> | undefined,
        ) => Promise<{
          result: string
          stream: ProtocolServerStreamInterface<string>
        }>
      >()
    })
  })

  describe('Safe client', () => {
    const client = new RuntimeClient(api, new MockTransport(), {
      safe: true,
      timeout: 1,
    })

    it('should properly resolve types', () => {
      expectTypeOf(
        client._?.api.test.procedures.simple.input,
      ).toEqualTypeOf<string>()
      expectTypeOf(
        client._?.api.test.procedures.simple.output,
      ).toEqualTypeOf<string>()
    })

    it('should properly resolve call types', () => {
      type Response = (
        data: string,
        options?: Partial<ProtocolBaseClientCallOptions> | undefined,
      ) => Promise<OneOf<[{ output: string }, { error: ProtocolError }]>>

      expectTypeOf(client.call.test.simple).toEqualTypeOf<Response>()
      expectTypeOf(client.call.test.simpleInline).toEqualTypeOf<Response>()
      expectTypeOf(client.call.test.stream).toEqualTypeOf<
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
    })
  })
})
