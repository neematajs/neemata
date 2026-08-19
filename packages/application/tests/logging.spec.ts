import { Writable } from 'node:stream'

import {
  createFactoryInjectable,
  createLogger,
  createValueInjectable,
  Scope,
} from '@nmtjs/core'
import { describe, expect, it } from 'vitest'

import type {
  AnyMiddleware,
  LoggingCallContextBuilder,
  LoggingCallMiddlewareOptions,
} from '../src/index.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  LoggingCallContextMiddleware,
  LoggingCallMiddleware,
  NeemataApplication,
} from '../src/index.ts'

const createTestRuntime = (
  middlewares: AnyMiddleware[],
  logs: Record<string, unknown>[],
) => {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(JSON.parse(chunk.toString()))
      callback()
    },
  })
  const logger = createLogger(
    { destinations: [{ level: 'trace', stream }] },
    'test',
  )
  const router = createRootRouter([
    createRouter({
      routes: {
        ping: createProcedure({ handler: () => 'pong' }),
      },
    }),
  ])

  return new NeemataApplication(
    defineApplication({
      router,
      middlewares,
    }),
    { logger },
  )
}

const call = async (runtime: NeemataApplication, payload: unknown) => {
  const container = runtime.container.fork(Scope.Call)
  try {
    return await runtime.api.call({
      connection: { id: 'connection-1' } as any,
      container,
      payload,
      procedure: 'ping',
      signal: new AbortController().signal,
    })
  } finally {
    await container.dispose()
  }
}

describe('LoggingCallMiddleware', () => {
  it('resolves options through the call container', async () => {
    const logs: Record<string, unknown>[] = []
    let resolutions = 0
    const options = createFactoryInjectable<
      LoggingCallMiddlewareOptions,
      {},
      Scope.Call
    >({
      scope: Scope.Call,
      create: () => {
        resolutions++
        return {
          level: 'debug',
          includePayload: false,
          includeResponse: false,
        }
      },
    })
    const runtime = createTestRuntime([LoggingCallMiddleware(options)], logs)

    try {
      await runtime.initialize()
      await call(runtime, { secret: true })
      await call(runtime, { secret: true })

      expect(resolutions).toBe(2)
      expect(logs.filter((entry) => entry.msg === 'RPC call')).toEqual([
        expect.objectContaining({ level: 20, procedure: 'ping' }),
        expect.objectContaining({ level: 20, procedure: 'ping' }),
      ])
      expect(logs.some((entry) => 'payload' in entry)).toBe(false)
      expect(logs.some((entry) => 'response' in entry)).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps the existing option defaults', async () => {
    const logs: Record<string, unknown>[] = []
    const runtime = createTestRuntime(
      [LoggingCallMiddleware(createValueInjectable({}))],
      logs,
    )

    try {
      await runtime.initialize()
      await call(runtime, { visible: true })

      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 30,
            msg: 'RPC call',
            payload: { visible: true },
          }),
          expect.objectContaining({
            level: 30,
            msg: 'RPC response',
            response: 'pong',
          }),
        ]),
      )
    } finally {
      await runtime.dispose()
    }
  })
})

describe('LoggingCallContextMiddleware', () => {
  it('accepts a static context builder injectable', async () => {
    const logs: Record<string, unknown>[] = []
    const builder = createValueInjectable<LoggingCallContextBuilder>(
      (call) => ({
        callId: call.callId,
        connection: { id: call.connection.id },
      }),
    )
    const runtime = createTestRuntime(
      [
        LoggingCallContextMiddleware(builder),
        LoggingCallMiddleware(createValueInjectable({})),
      ],
      logs,
    )

    try {
      await runtime.initialize()
      await call(runtime, { visible: true })

      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callId: expect.any(String),
            connection: { id: 'connection-1' },
            msg: 'RPC call',
          }),
        ]),
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('resolves context dependencies through the call container', async () => {
    const logs: Record<string, unknown>[] = []
    let resolutions = 0
    let disposals = 0
    const builder = createFactoryInjectable<
      LoggingCallContextBuilder,
      {},
      Scope.Call
    >({
      scope: Scope.Call,
      create: () => {
        resolutions++
        return (call, payload) => ({
          callId: call.callId,
          request: payload,
          tenant: 'tenant-1',
        })
      },
      dispose: () => {
        disposals++
      },
    })
    const runtime = createTestRuntime(
      [
        LoggingCallContextMiddleware(builder),
        LoggingCallMiddleware(createValueInjectable({})),
      ],
      logs,
    )

    try {
      await runtime.initialize()
      await call(runtime, { visible: true })
      await call(runtime, { visible: true })

      expect(resolutions).toBe(2)
      expect(disposals).toBe(2)
      expect(logs.filter((entry) => entry.msg === 'RPC call')).toEqual([
        expect.objectContaining({
          request: { visible: true },
          tenant: 'tenant-1',
        }),
        expect.objectContaining({
          request: { visible: true },
          tenant: 'tenant-1',
        }),
      ])
    } finally {
      await runtime.dispose()
    }
  })
})
