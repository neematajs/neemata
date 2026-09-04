import type { Schema, WireSchema } from '@nmtjs/common/schema'
import { onceAborted } from '@nmtjs/common'
import { isSchema, isWireSchemaCodec } from '@nmtjs/common/schema'
import { Container, createLogger, Scope } from '@nmtjs/core'
import { GatewayInjectables } from '@nmtjs/gateway'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { AnyFilter, AnyProcedure } from '../src/index.ts'
import {
  ApiError,
  ApplicationApi,
  createFilter,
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
