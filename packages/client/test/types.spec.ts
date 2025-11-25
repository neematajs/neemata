import type { OneOf } from '@nmtjs/common'
import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import type {
  ProtocolError,
  ProtocolServerBlobStream,
  ProtocolServerStreamInterface,
} from '@nmtjs/protocol/client'
import { c } from '@nmtjs/contract'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { describe, expectTypeOf, it } from 'vitest'

import type { BaseClientOptions } from '../src/common.ts'
import type { ClientCallOptions } from '../src/types.ts'
import { RuntimeClient } from '../src/clients/runtime.ts'
import {
  createUnidirectionalTransportMock,
  RuntimeTestFormat,
} from './_setup.ts'

describe('Types', () => {
  const simpleProcedure = c.procedure({ input: t.string(), output: t.string() })
  const simpleBlobProcedure = c.procedure({
    input: t.object({ blob: c.blob() }),
    output: t.object({ blob: c.blob() }),
  })
  const simpleProcedureWithCustomType = c.procedure({
    input: t.object({
      date: t.date(),
      record: t.record(t.string(), t.date()),
      array: t.array(t.date()),
      tuple: t.tuple([t.date()]),
    }),
    output: t.object({
      date: t.date(),
      record: t.record(t.string(), t.date()),
      array: t.array(t.date()),
      tuple: t.tuple([t.date()]),
    }),
  })

  const streamProcedure = c.procedure({
    input: t.string(),
    output: t.string(),
    stream: true,
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
      simpleBlob: simpleBlobProcedure,
      simpleCustomType: simpleProcedureWithCustomType,
    },
  })

  const createUnsafeClient = () => {
    const format = new RuntimeTestFormat()
    const { transport } = createUnidirectionalTransportMock()
    const options: BaseClientOptions<typeof router, false> = {
      contract: router,
      protocol: ProtocolVersion.v1,
      format,
    }
    return new RuntimeClient(options, transport, undefined)
  }

  const createSafeClient = () => {
    const format = new RuntimeTestFormat()
    const { transport } = createUnidirectionalTransportMock()
    const options: BaseClientOptions<typeof router, true> = {
      contract: router,
      protocol: ProtocolVersion.v1,
      format,
      safe: true,
    }
    return new RuntimeClient(options, transport, undefined)
  }

  describe('Unsafe client', () => {
    type UnsafeClient = ReturnType<typeof createUnsafeClient>
    type UnsafeRoutes = UnsafeClient['_']['routes']['routes']
    type UnsafeCallers = UnsafeClient['call']

    it('should properly resolve types', () => {
      expectTypeOf<UnsafeRoutes['simple']['input']>().toEqualTypeOf<string>()
      expectTypeOf<UnsafeRoutes['simple']['output']>().toEqualTypeOf<string>()
      expectTypeOf<
        UnsafeRoutes['nested']['routes']['simple']['input']
      >().toEqualTypeOf<string>()
      expectTypeOf<
        UnsafeRoutes['nested']['routes']['simple']['output']
      >().toEqualTypeOf<string>()
      expectTypeOf<
        UnsafeRoutes['nested']['routes']['nestedRouter1']['routes']['simple']['input']
      >().toEqualTypeOf<string>()
      expectTypeOf<
        UnsafeRoutes['nested']['routes']['nestedRouter1']['routes']['simple']['output']
      >().toEqualTypeOf<string>()
      expectTypeOf<UnsafeRoutes['simpleBlob']['input']>().toEqualTypeOf<{
        blob: ProtocolBlobInterface
      }>()
      expectTypeOf<UnsafeRoutes['simpleBlob']['output']>().toEqualTypeOf<{
        blob: ProtocolServerBlobStream
      }>()
      expectTypeOf<UnsafeRoutes['simpleCustomType']['input']>().toEqualTypeOf<{
        date: Date
        record: Record<string, Date>
        array: Date[]
        tuple: [Date]
      }>()
      expectTypeOf<UnsafeRoutes['simpleCustomType']['output']>().toEqualTypeOf<{
        date: Date
        record: Record<string, Date>
        array: Date[]
        tuple: [Date]
      }>()
    })

    it('should properly resolve call types', () => {
      type Response = (
        data: string,
        options?: Partial<ClientCallOptions> | undefined,
      ) => Promise<string>

      expectTypeOf<UnsafeCallers['simple']>().toEqualTypeOf<Response>()
      expectTypeOf<UnsafeCallers['simpleInline']>().toEqualTypeOf<Response>()
      expectTypeOf<UnsafeCallers['stream']>().toEqualTypeOf<
        (
          data: string,
          options?: Partial<ClientCallOptions> | undefined,
        ) => Promise<ProtocolServerStreamInterface<string>>
      >()
      expectTypeOf<
        UnsafeCallers['nested']['simple']
      >().toEqualTypeOf<Response>()
      expectTypeOf<
        UnsafeCallers['nested']['nestedRouter1']['simple']
      >().toEqualTypeOf<Response>()
    })
  })

  describe('Safe client', () => {
    type SafeClient = ReturnType<typeof createSafeClient>
    type SafeRoutes = SafeClient['_']['routes']['routes']
    type SafeCallers = SafeClient['call']

    it('should properly resolve types', () => {
      expectTypeOf<SafeRoutes['simple']['input']>().toEqualTypeOf<string>()
      expectTypeOf<SafeRoutes['simple']['output']>().toEqualTypeOf<string>()
    })

    it('should properly resolve call types', () => {
      type Response = (
        data: string,
        options?: Partial<ClientCallOptions> | undefined,
      ) => Promise<OneOf<[{ result: string }, { error: ProtocolError }]>>

      expectTypeOf<SafeCallers['simple']>().toEqualTypeOf<Response>()
      expectTypeOf<SafeCallers['simpleInline']>().toEqualTypeOf<Response>()
      expectTypeOf<SafeCallers['stream']>().toEqualTypeOf<
        (
          data: string,
          options?: Partial<ClientCallOptions> | undefined,
        ) => Promise<
          OneOf<
            [
              { result: ProtocolServerStreamInterface<string> },
              { error: ProtocolError },
            ]
          >
        >
      >()
      expectTypeOf<SafeCallers['nested']['simple']>().toEqualTypeOf<Response>()
      expectTypeOf<
        SafeCallers['nested']['nestedRouter1']['simple']
      >().toEqualTypeOf<Response>()
    })
  })
})
