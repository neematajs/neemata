import { Writable } from 'node:stream'

import type { Logger } from '@nmtjs/core'
import { CoreInjectables, createLogger } from '@nmtjs/core'
import {
  LoggingCallContextMiddleware,
  LoggingCallMiddleware,
} from 'nmtjs/runtime'
import { afterEach, describe, expect, it } from 'vitest'

import type { TestSetup } from './_setup.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  createTestSetup,
  t,
} from './_setup.ts'

type CapturedLog = Record<string, any>

const echoProcedure = createProcedure({
  input: t.object({ message: t.string() }),
  output: t.object({ echoed: t.string() }),
  dependencies: { logger: CoreInjectables.logger('HandlerLogger') },
  handler: ({ logger }, input) => {
    logger.info({ handler: true }, 'Handler log')
    return { echoed: input.message }
  },
})

const streamProcedure = createProcedure({
  input: t.object({ count: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  dependencies: { logger: CoreInjectables.logger('HandlerLogger') },
  async *handler({ logger }, { count }) {
    for (let i = 0; i < count; i++) {
      logger.info({ handler: true, index: i }, 'Stream handler log')
      yield { index: i }
    }
  },
})

const failingProcedure = createProcedure({
  input: t.object({ message: t.string() }),
  output: t.never(),
  handler: () => {
    throw new Error('Boom')
  },
})

const router = createRootRouter([
  createRouter({
    routes: {
      echo: echoProcedure,
      stream: streamProcedure,
      fail: failingProcedure,
    },
  }),
] as const)

const waitForLogs = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function createCapturingLogger(label = 'test') {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })

  const logger = createLogger(
    {
      destinations: [{ level: 'trace', stream }],
      pinoOptions: { level: 'trace' },
    },
    label,
  )

  const getLogs = (): CapturedLog[] =>
    chunks.flatMap((chunk) =>
      chunk
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapturedLog),
    )

  return { logger, getLogs }
}

describe('logging middlewares', () => {
  let activeSetup: TestSetup<typeof router> | undefined

  afterEach(async () => {
    await activeSetup?.cleanup()
    activeSetup = undefined
  })

  async function setupWithLogger(logger: Logger, middlewares: any[]) {
    activeSetup = await createTestSetup({ router, logger, middlewares })

    return activeSetup
  }

  it('applies async local storage context to handler logs', async () => {
    const { logger, getLogs } = createCapturingLogger()
    const setup = await setupWithLogger(logger, [
      LoggingCallContextMiddleware((_call, payload) => ({
        requestId: 'req-1',
        rawPayload: payload,
      })),
    ])

    await setup.client.call.echo({ message: 'hello' })
    await waitForLogs()

    const handlerLog = getLogs().find((entry) => entry.msg === 'Handler log')

    expect(handlerLog).toBeDefined()
    expect(handlerLog?.requestId).toBe('req-1')
    expect(handlerLog?.rawPayload).toEqual({ message: 'hello' })
    expect(handlerLog?.handler).toBe(true)
  })

  it('does not leak async local storage across subsequent calls', async () => {
    const { logger, getLogs } = createCapturingLogger()
    const setup = await setupWithLogger(logger, [
      LoggingCallContextMiddleware((_call, payload) => ({
        requestId: (payload as { message: string }).message,
        rawPayload: payload,
      })),
    ])

    await setup.client.call.echo({ message: 'first' })
    await waitForLogs()
    logger.info({ outside: true }, 'Outside log after first call')

    await setup.client.call.echo({ message: 'second' })
    await waitForLogs()
    logger.info({ outside: true }, 'Outside log after second call')
    await waitForLogs()

    const handlerLogs = getLogs().filter((entry) => entry.msg === 'Handler log')
    const outsideLogs = getLogs().filter((entry) => entry.outside === true)

    expect(handlerLogs).toHaveLength(2)
    expect(handlerLogs.map((entry) => entry.requestId)).toEqual([
      'first',
      'second',
    ])
    expect(handlerLogs.map((entry) => entry.rawPayload)).toEqual([
      { message: 'first' },
      { message: 'second' },
    ])

    expect(outsideLogs).toHaveLength(2)
    for (const outsideLog of outsideLogs) {
      expect(outsideLog.requestId).toBeUndefined()
      expect(outsideLog.rawPayload).toBeUndefined()
    }
  })

  it('logs payload and result for successful calls', async () => {
    const { logger, getLogs } = createCapturingLogger()
    const setup = await setupWithLogger(logger, [LoggingCallMiddleware()])

    await setup.client.call.echo({ message: 'hello' })
    await waitForLogs()

    const rpcCallLog = getLogs().find((entry) => entry.msg === 'RPC call')
    const rpcResponseLog = getLogs().find(
      (entry) => entry.msg === 'RPC response',
    )

    expect(rpcCallLog).toMatchObject({
      procedure: 'echo',
      payload: { message: 'hello' },
    })
    expect(rpcResponseLog).toMatchObject({
      result: 'success',
      response: { echoed: 'hello' },
    })
  })

  it('logs stream responses and chunks', async () => {
    const { logger, getLogs } = createCapturingLogger()
    const setup = await setupWithLogger(logger, [LoggingCallMiddleware()])

    const stream = await setup.client.stream.stream({ count: 3 })
    const chunks: unknown[] = []

    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    await waitForLogs()

    const rpcCallLog = getLogs().find((entry) => entry.msg === 'RPC call')
    const rpcResponseLog = getLogs().find(
      (entry) => entry.msg === 'RPC response',
    )
    const rpcChunkLogs = getLogs().filter(
      (entry) => entry.msg === 'RPC stream chunk',
    )

    expect(chunks).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])
    expect(rpcCallLog).toMatchObject({
      procedure: 'stream',
      payload: { count: 3 },
    })
    expect(rpcResponseLog).toMatchObject({
      result: 'success',
      response: 'Stream',
    })
    expect(rpcChunkLogs).toHaveLength(3)
    expect(
      rpcChunkLogs.every((entry) => typeof entry.callId === 'string'),
    ).toBe(true)
    expect(new Set(rpcChunkLogs.map((entry) => entry.callId)).size).toBe(1)
    expect(rpcChunkLogs.map((entry) => entry.chunk)).toEqual([
      { index: 0 },
      { index: 1 },
      { index: 2 },
    ])
  })

  it('can disable stream chunk logging while keeping stream response logging', async () => {
    const { logger, getLogs } = createCapturingLogger()
    const setup = await setupWithLogger(logger, [
      LoggingCallMiddleware({ includeStreamChunks: false }),
    ])

    const stream = await setup.client.stream.stream({ count: 3 })

    for await (const _chunk of stream) {
      // Consume the stream fully.
    }
    await waitForLogs()

    const rpcResponseLog = getLogs().find(
      (entry) => entry.msg === 'RPC response',
    )
    const rpcChunkLogs = getLogs().filter(
      (entry) => entry.msg === 'RPC stream chunk',
    )

    expect(rpcResponseLog).toMatchObject({
      result: 'success',
      response: 'Stream',
    })
    expect(rpcChunkLogs).toHaveLength(0)
  })

  it('respects payload/result logging options', async () => {
    const { logger, getLogs } = createCapturingLogger()
    const setup = await setupWithLogger(logger, [
      LoggingCallMiddleware({ includePayload: false, includeResponse: false }),
    ])

    await setup.client.call.echo({ message: 'hello' })
    await waitForLogs()

    const rpcCallLog = getLogs().find((entry) => entry.msg === 'RPC call')
    const rpcResponseLog = getLogs().find(
      (entry) => entry.msg === 'RPC response',
    )

    expect(rpcCallLog).toMatchObject({ procedure: 'echo' })
    expect(rpcCallLog).not.toHaveProperty('payload')
    expect(rpcResponseLog).toMatchObject({ result: 'success' })
    expect(rpcResponseLog).not.toHaveProperty('response')
  })

  it('logs call errors', async () => {
    const { logger, getLogs } = createCapturingLogger()
    const setup = await setupWithLogger(logger, [LoggingCallMiddleware()])

    await expect(setup.client.call.fail({ message: 'hello' })).rejects.toThrow(
      'Internal Server Error',
    )
    await waitForLogs()

    const rpcErrorLog = getLogs().find((entry) => entry.msg === 'RPC error')
    const rpcResponseLog = getLogs().find(
      (entry) => entry.msg === 'RPC response',
    )

    expect(rpcErrorLog).toHaveProperty('error')
    expect(rpcResponseLog).toBeUndefined()
  })
})
