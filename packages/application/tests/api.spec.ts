import { Buffer } from 'node:buffer'

import type { Schema, WireSchema } from '@nmtjs/common/schema'
import type { TransportWorkerParams } from '@nmtjs/gateway'
import { onceAborted } from '@nmtjs/common'
import { isSchema, isWireSchemaCodec, noopSchema } from '@nmtjs/common/schema'
import { c } from '@nmtjs/contract'
import { Container, createLogger, Hooks, Scope } from '@nmtjs/core'
import { Gateway, GatewayInjectables } from '@nmtjs/gateway'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import {
  ClientMessageType,
  ConnectionType,
  ErrorCode,
  ProtocolVersion,
  ServerMessageType,
} from '@nmtjs/protocol'
import { ProtocolError, ProtocolFormats } from '@nmtjs/protocol/server'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { AnyFilter, AnyProcedure } from '../src/index.ts'
import {
  ApiError,
  ApplicationApi,
  createFilter,
  createContractProcedure,
  createMiddleware,
  createProcedure,
} from '../src/index.ts'

const asyncSchema = <Input, Output>(
  transform: (value: Input) => Promise<Output>,
): Schema<Input, Output> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      return { value: await transform(value as Input) }
    },
  },
})

import { config } from '../src/api/config.ts'

class DomainError extends Error {}

function createTestApi(options: {
  procedure: AnyProcedure
  filters?: AnyFilter[]
  timeout?: number
}) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  const container = new Container({ logger })

  const api = new ApplicationApi({
    timeout: options.timeout,
    container,
    logger,
    procedures: new Map([['test', { procedure: options.procedure, path: [] }]]),
    meta: [],
    guards: new Set(),
    middlewares: new Set(),
    filters: new Set(options.filters ?? []),
  })

  const connectionAbort = new AbortController()
  const clientAbort = new AbortController()

  const connectionContainer = container.fork(Scope.Connection)
  connectionContainer.provide(
    GatewayInjectables.connectionAbortSignal,
    connectionAbort.signal,
  )

  const callContainer = connectionContainer.fork(Scope.Call)
  callContainer.provide(
    GatewayInjectables.rpcClientAbortSignal,
    clientAbort.signal,
  )

  const call = (payload?: any) =>
    api.call({
      connection: {} as any,
      procedure: 'test',
      container: callContainer,
      payload,
      signal: clientAbort.signal,
    })

  return { api, call, logger }
}

describe('ApplicationApi filters', () => {
  it('applies a filter returning a ProtocolError', async () => {
    const filter = createFilter({
      errorClass: DomainError,
      handler: () => new ProtocolError(ErrorCode.Forbidden, 'Mapped'),
    })
    const procedure = createProcedure({
      handler: () => {
        throw new DomainError('boom')
      },
    })
    const { call } = createTestApi({ procedure, filters: [filter] })

    await expect(call()).rejects.toMatchObject({ code: ErrorCode.Forbidden })
  })

  it('applies a filter returning a plain Error, without leaking it to the wire', async () => {
    const filter = createFilter({
      errorClass: DomainError,
      handler: () => new Error('internal details'),
    })
    const procedure = createProcedure({
      handler: () => {
        throw new DomainError('boom')
      },
    })
    const { call, logger } = createTestApi({ procedure, filters: [filter] })
    const logged = vi.spyOn(logger, 'error')

    const error: ApiError = await call().then(
      () => expect.unreachable(),
      (error) => error,
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe(ErrorCode.InternalServerError)
    expect(error.message).not.toContain('internal details')
    // the filter's error must still be observable in logs
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: expect.objectContaining({ message: 'internal details' }),
      }),
    )
  })

  it('falls through to a generic error when a filter returns nothing', async () => {
    const filter = createFilter({
      errorClass: DomainError,
      handler: () => undefined as any,
    })
    const procedure = createProcedure({
      handler: () => {
        throw new DomainError('boom')
      },
    })
    const { call } = createTestApi({ procedure, filters: [filter] })

    await expect(call()).rejects.toMatchObject({
      code: ErrorCode.InternalServerError,
    })
  })
})

describe('ApplicationApi timeout', () => {
  it('aborts the handler signal when the procedure times out', async () => {
    let observed: AbortSignal | undefined
    const procedure = createProcedure({
      timeout: 20,
      dependencies: { signal: GatewayInjectables.rpcAbortSignal },
      handler: async (ctx) => {
        observed = ctx.signal
        await onceAborted(ctx.signal)
        return 'done'
      },
    })
    const { call } = createTestApi({ procedure })

    await expect(call()).rejects.toMatchObject({
      code: ErrorCode.RequestTimeout,
    })
    expect(observed?.aborted).toBe(true)
    expect(observed?.reason).toBeInstanceOf(ApiError)
    expect(observed?.reason).toMatchObject({ code: ErrorCode.RequestTimeout })
  })

  it('does not abort the handler signal when the call completes in time', async () => {
    vi.useFakeTimers()
    try {
      let observed: AbortSignal | undefined
      const procedure = createProcedure({
        timeout: 1000,
        dependencies: { signal: GatewayInjectables.rpcAbortSignal },
        handler: async (ctx) => {
          observed = ctx.signal
          return 'done'
        },
      })
      const { call } = createTestApi({ procedure })

      await call()
      expect(observed?.aborted).toBe(false)

      // the timeout timer must be cleared on completion, a late firing
      // would abort the still-referenced call signal
      await vi.advanceTimersByTimeAsync(2000)
      expect(observed?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ApplicationApi schemas', () => {
  it('preserves inferred output types for async handlers and streams', () => {
    const sync = createProcedure(() => ({ id: 1, label: 'one' }))
    const async = createProcedure({ handler: async () => ({ id: 1 }) })
    const stream = createProcedure({
      stream: true,
      async *handler() {
        yield { id: 1 }
      },
    })

    expectTypeOf<
      WireSchema.EncodeOutput<typeof sync.contract.output>
    >().toEqualTypeOf<{ id: number; label: string }>()
    expectTypeOf<
      WireSchema.EncodeOutput<typeof async.contract.output>
    >().toEqualTypeOf<{ id: number }>()
    expectTypeOf<
      WireSchema.EncodeOutput<typeof stream.contract.output>
    >().toEqualTypeOf<{ id: number }>()
    expectTypeOf<typeof stream.contract.stream>().toEqualTypeOf<true>()
  })

  it('represents inferred outputs as an encode-only passthrough schema', async () => {
    const procedure = createProcedure({ handler: () => ({ ok: true }) })
    const { call } = createTestApi({ procedure })

    expect(isSchema(procedure.contract.output)).toBe(true)
    expect(isWireSchemaCodec(procedure.contract.output)).toBe(false)
    expectTypeOf<
      WireSchema.EncodeInput<typeof procedure.contract.output>
    >().toEqualTypeOf<{ ok: boolean }>()
    await expect(call()).resolves.toEqual({ ok: true })
  })

  it('awaits provider-independent input and output transforms', async () => {
    const input: WireSchema.Decode<string, number> = asyncSchema(
      async (value) => Number(value),
    )
    const output: WireSchema.Encode<number, string> = asyncSchema(
      async (value) => String(value),
    )
    const procedure = createProcedure({
      input,
      output,
      handler: (_ctx, value) => value + 1,
    })
    const { call } = createTestApi({ procedure })

    await expect(call('41')).resolves.toBe('42')
  })
})

describe('ApplicationApi schema boundaries', () => {
  const values = [undefined, null, false, 0, '', { ok: true }]

  it.each(values)('ignores input without a schema: %j', async (value) => {
    const handler = vi.fn((_ctx, input: unknown) => input)
    const { call } = createTestApi({ procedure: createProcedure({ handler }) })
    await expect(call(value)).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledWith(expect.anything(), undefined)
  })

  it.each(values)('preserves unconstrained input/output: %j', async (value) => {
    for (const input of [t.any(), noopSchema()]) {
      for (const output of [undefined, t.any(), noopSchema()]) {
        const { call } = createTestApi({
          procedure: createProcedure({
            input,
            output,
            handler: (_ctx, input) => input,
          }),
        })
        await expect(call(value)).resolves.toBe(value)
      }
    }
  })

  it('applies defaults to undefined and distinguishes next() from next(undefined)', async () => {
    for (const replace of [false, true]) {
      const { call } = createTestApi({
        procedure: createProcedure({
          input: t.string().default('default'),
          middlewares: [
            createMiddleware((_ctx, _call, next) =>
              replace ? next(undefined) : next(),
            ),
          ],
          handler: (_ctx, input) => input,
        }),
      })
      await expect(call('provided')).resolves.toBe(
        replace ? 'default' : 'provided',
      )
      await expect(call()).resolves.toBe('default')
    }
  })

  it('validates optional and never schemas instead of treating them as absent', async () => {
    const handler = vi.fn((_ctx, input) => input)
    const optional = createTestApi({
      procedure: createProcedure({ input: t.string().optional(), handler }),
    })
    await expect(optional.call()).resolves.toBeUndefined()
    await expect(optional.call(0)).rejects.toMatchObject({
      code: ErrorCode.ValidationError,
    })
    expect(handler).toHaveBeenCalledTimes(1)
    const never = createTestApi({
      procedure: createProcedure({ input: t.never(), handler }),
    })
    await expect(never.call()).rejects.toMatchObject({
      code: ErrorCode.ValidationError,
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('keeps absent contract outputs distinct from inferred outputs', async () => {
    const handler = vi.fn(() => undefined)
    const { call } = createTestApi({
      procedure: createContractProcedure(c.procedure({}), handler),
    })
    await expect(call()).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
    const invalidStream = createTestApi({
      procedure: createContractProcedure(
        c.procedure({ stream: true }),
        async function* () {
          yield undefined
        },
      ),
    })
    await expect(invalidStream.call()).rejects.toMatchObject({
      code: ErrorCode.InternalServerError,
    })
  })

  it('awaits stream encoding and invokes completion on validation failure', async () => {
    const output = asyncSchema(async (value: number) => {
      if (value < 0) throw new Error('invalid output')
      return String(value)
    })
    const { call } = createTestApi({
      procedure: createProcedure({
        output,
        stream: true,
        async *handler() {
          yield 1
          yield -1
        },
      }),
    })
    const response = await call()
    if (typeof response !== 'function')
      throw new Error('Expected a stream factory')
    const done = vi.fn()
    const stream = response(done)
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: '1',
    })
    await expect(stream.next()).rejects.toThrow('invalid output')
    expect(done).toHaveBeenCalledOnce()
  })

  it('respects serializeOutput for both unary and stream procedures', async () => {
    const date = new Date('2026-09-08T00:00:00.000Z')
    for (const serializeOutput of [true, false]) {
      const meta = [config.static({ serializeOutput })]
      const unary = createTestApi({
        procedure: createProcedure({
          output: t.date(),
          meta,
          handler: () => date,
        }),
      })
      await expect(unary.call()).resolves.toEqual(
        serializeOutput ? date.toISOString() : date,
      )
      const streaming = createTestApi({
        procedure: createProcedure({
          output: t.date(),
          meta,
          stream: true,
          async *handler() {
            yield date
          },
        }),
      })
      const response = await streaming.call()
      if (typeof response !== 'function')
        throw new Error('Expected a stream factory')
      const stream = response()
      await expect(stream.next()).resolves.toMatchObject({
        done: false,
        value: serializeOutput ? date.toISOString() : date,
      })
      await expect(stream.next()).resolves.toMatchObject({ done: true })
    }
  })
})

describe('ApplicationApi through Gateway with real formats', () => {
  it.each([
    ['JSON', () => new JsonFormat()],
    ['MessagePack', () => new MsgpackFormat()],
  ] as const)(
    'preserves unary values and rejects undefined stream chunks with %s',
    async (_name, createFormat) => {
      const format = createFormat()
      const { api, logger } = createTestApi({
        procedure: createProcedure({
          input: t.any(),
          handler: (_ctx, value) => value,
        }),
      })
      api.options.procedures.set('stream', {
        path: [],
        procedure: createProcedure({
          stream: true,
          async *handler() {
            yield 0
            yield false
            yield ''
            yield null
            yield undefined
          },
        }),
      })
      let transportParams: TransportWorkerParams | undefined
      const sent: Buffer[] = []
      const gateway = new Gateway({
        logger,
        container: api.options.container,
        hooks: new Hooks(),
        formats: new ProtocolFormats([format]),
        transports: {
          test: {
            transport: {
              start(params) {
                transportParams = params
                return 'test://'
              },
              stop() {},
              send(_connectionId, data) {
                sent.push(
                  Buffer.from(data.buffer, data.byteOffset, data.byteLength),
                )
                return true
              },
              close() {},
            },
          },
        },
        api,
        heartbeat: false,
      })
      await gateway.start()
      try {
        if (!transportParams) throw new Error('Transport did not start')
        const params = transportParams
        const connection = await params.onConnect({
          type: ConnectionType.Bidirectional,
          protocolVersion: ProtocolVersion.v1,
          accept: format.contentType,
          contentType: format.contentType,
          data: {},
        })
        const request = (callId: number, procedure: string, value: unknown) => {
          const name = Buffer.from(procedure)
          const header = Buffer.alloc(7)
          header.writeUInt8(ClientMessageType.Rpc, 0)
          header.writeUInt32LE(callId, 1)
          header.writeUInt16LE(name.byteLength, 5)
          const payload = format.encodeRPC(value, {})
          return Uint8Array.from(
            Buffer.concat([header, name, Buffer.from(payload)]),
          ).buffer
        }
        let callId = 1
        for (const value of [undefined, null, false, 0, '', { ok: true }]) {
          sent.length = 0
          await params.onMessage({
            connectionId: connection.id,
            data: request(callId++, 'test', value),
          })
          expect(sent).toHaveLength(1)
          expect(sent[0].readUInt8(0)).toBe(ServerMessageType.RpcResponse)
          expect(sent[0].readUInt8(5)).toBe(0)
          expect(
            format.decodeRPC(sent[0].subarray(6), {
              addStream() {
                throw new Error('Unexpected blob')
              },
            }),
          ).toEqual(value)
          await expect(
            params.onRpc(
              connection,
              { callId: callId++, procedure: 'test', payload: value },
              new AbortController().signal,
            ),
          ).resolves.toEqual(value)
        }

        sent.length = 0
        const streamCallId = callId++
        const running = params.onMessage({
          connectionId: connection.id,
          data: request(streamCallId, 'stream', undefined),
        })
        await vi.waitFor(() =>
          expect(sent[0]?.readUInt8(0)).toBe(
            ServerMessageType.RpcStreamResponse,
          ),
        )
        const pull = Buffer.alloc(9)
        pull.writeUInt8(ClientMessageType.RpcStreamPull, 0)
        pull.writeUInt32LE(streamCallId, 1)
        pull.writeUInt32LE(6, 5)
        await params.onMessage({
          connectionId: connection.id,
          data: Uint8Array.from(pull).buffer,
        })
        await running
        const chunks = sent.filter(
          (message) =>
            message.readUInt8(0) === ServerMessageType.RpcStreamChunk,
        )
        expect(
          chunks.map((message) => format.decode(message.subarray(5))),
        ).toEqual([0, false, '', null])
        expect(sent.at(-1)?.readUInt8(0)).toBe(ServerMessageType.RpcStreamAbort)
        expect(gateway.rpcs.get(connection.id, streamCallId)).toBeUndefined()
      } finally {
        await gateway.stop()
      }
    },
  )
})
