import { Writable } from 'node:stream'

import type { Level, Logger as Pino } from 'pino'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import { pino, stdSerializers } from 'pino'
import { describe, expect, it } from 'vitest'

import { makePinoLogger, pinoLoggerLayer } from '../src/effect.ts'

function capture(level: Level = 'trace', redact?: string[]) {
  const records: Record<string, any>[] = []
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      records.push(JSON.parse(String(chunk)))
      callback()
    },
  })
  const logger = pino(
    { level, redact, serializers: { err: stdSerializers.errWithCause } },
    destination,
  )
  return { logger, records }
}

function run(logger: Pino, effect: Effect.Effect<unknown>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(pinoLoggerLayer(logger)),
      Effect.provideService(References.MinimumLogLevel, 'All'),
    ),
  )
}

describe('Pino logger', () => {
  it('maps Effect levels to Pino levels', async () => {
    const { logger, records } = capture()
    await run(
      logger,
      Effect.all([
        Effect.logFatal('fatal'),
        Effect.logError('error'),
        Effect.logWarning('warn'),
        Effect.logInfo('info'),
        Effect.logDebug('debug'),
        Effect.logTrace('trace'),
      ]),
    )
    expect(records.map(({ level, msg }) => [level, msg])).toEqual([
      [60, 'fatal'],
      [50, 'error'],
      [40, 'warn'],
      [30, 'info'],
      [20, 'debug'],
      [10, 'trace'],
    ])
  })

  it("skips entries below the Pino logger's level", async () => {
    const { logger, records } = capture('warn')
    await run(
      logger,
      Effect.all([Effect.logInfo('quiet'), Effect.logWarning('loud')]),
    )
    expect(records.map(({ msg }) => msg)).toEqual(['loud'])
  })

  it('writes annotations, spans and the fiber id as fields', async () => {
    const { logger, records } = capture()
    await run(
      logger,
      Effect.log('hello').pipe(
        Effect.annotateLogs({ requestId: 'r-1', attempt: 2 }),
        Effect.withLogSpan('handler'),
      ),
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 30,
      msg: 'hello',
      requestId: 'r-1',
      attempt: 2,
      spans: { handler: expect.any(Number) },
      fiberId: expect.stringMatching(/^#\d+$/),
    })
    expect(records[0]).not.toHaveProperty('message')
    expect(records[0]).not.toHaveProperty('err')
  })

  it('joins string parts into msg and keeps other values structured', async () => {
    const { logger, records } = capture()
    await run(
      logger,
      Effect.all([
        Effect.log('user', 'created', { id: 1 }, [2]),
        Effect.log({ id: 3 }),
      ]),
    )
    expect(records[0]).toMatchObject({
      msg: 'user created',
      message: [{ id: 1 }, [2]],
    })
    expect(records[1]).toMatchObject({ message: { id: 3 } })
    expect(records[1]).not.toHaveProperty('msg')
  })

  it("leaves structured values to Pino's redaction", async () => {
    const { logger, records } = capture('trace', ['message.password'])
    await run(logger, Effect.log({ password: 'secret' }))
    expect(JSON.stringify(records[0])).not.toContain('secret')
  })

  it("moves annotations named like Pino's own fields under annotations", async () => {
    const { logger, records } = capture()
    await run(
      logger,
      Effect.logError('failure').pipe(
        Effect.annotateLogs({ level: 'info', time: 'yesterday', user: 'u-1' }),
      ),
    )
    expect(records[0]).toMatchObject({
      level: 50,
      time: expect.any(Number),
      user: 'u-1',
      annotations: { level: 'info', time: 'yesterday' },
    })
  })

  it('records an Error message part under err', async () => {
    const { logger, records } = capture()
    const error = new Error('boom')
    await run(logger, Effect.logError('request failed', error))
    expect(records[0]).toMatchObject({
      level: 50,
      msg: 'request failed',
      err: { type: 'Error', message: 'boom' },
    })
  })

  it('keeps the identity of a lone failure in the cause', async () => {
    const { logger, records } = capture()
    class NotFound extends Error {
      readonly _tag = 'NotFound'
    }
    await run(
      logger,
      Effect.logError('lookup failed', Cause.fail(new NotFound('missing'))),
    )
    expect(records[0]).toMatchObject({
      msg: 'lookup failed',
      err: { type: 'NotFound', message: 'missing', _tag: 'NotFound' },
    })
  })

  it('keeps a lone non-Error failure as it is', async () => {
    const { logger, records } = capture()
    await run(
      logger,
      Effect.logError(Cause.fail({ _tag: 'Unavailable', retryIn: 5 })),
    )
    expect(records[0].err).toEqual({ _tag: 'Unavailable', retryIn: 5 })
  })

  it('keeps several structured failures redactable', async () => {
    const { logger, records } = capture('trace', [
      'err.aggregateErrors[*].password',
    ])
    const cause = Cause.fromReasons([
      ...Cause.fail({ _tag: 'Denied', password: 'secret' }).reasons,
      ...Cause.die(new Error('second')).reasons,
    ])
    await run(logger, Effect.logError('both failed', cause))
    expect(JSON.stringify(records[0])).not.toContain('secret')
    expect(records[0].err.aggregateErrors).toEqual([
      { _tag: 'Denied', password: '[Redacted]' },
      expect.objectContaining({ message: 'second' }),
    ])
  })

  it('aggregates every Error message part with the cause', async () => {
    const { logger, records } = capture()
    await run(
      logger,
      Effect.logError(
        'failed',
        new Error('first'),
        new Error('second'),
        Cause.fail(new Error('cause')),
      ),
    )
    expect(records[0]).not.toHaveProperty('message')
    expect(records[0].err).toMatchObject({
      type: 'AggregateError',
      message: '3 errors',
      aggregateErrors: [
        expect.objectContaining({ message: 'cause' }),
        expect.objectContaining({ message: 'first' }),
        expect.objectContaining({ message: 'second' }),
      ],
    })
  })

  it('aggregates several failures in the cause', async () => {
    const { logger, records } = capture()
    const cause = Cause.fromReasons([
      ...Cause.fail(new Error('first')).reasons,
      ...Cause.die(new Error('second')).reasons,
    ])
    await run(logger, Effect.logError('both failed', cause))
    expect(records[0].err).toMatchObject({
      type: 'AggregateError',
      message: '2 errors',
      aggregateErrors: [
        expect.objectContaining({ message: 'first' }),
        expect.objectContaining({ message: 'second' }),
      ],
    })
  })

  it('does not report an interrupt-only cause as an error', async () => {
    const { logger, records } = capture()
    const fiber = Effect.runFork(Effect.never)
    const exit = await Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
    )
    expect(exit._tag).toBe('Failure')
    if (exit._tag !== 'Failure') return
    await run(logger, Effect.logInfo('stopped', exit.cause))
    expect(records[0]).toMatchObject({ msg: 'stopped' })
    expect(records[0]).not.toHaveProperty('err')
  })

  it('can be combined with other loggers', async () => {
    const { logger, records } = capture()
    const seen: unknown[] = []
    await Effect.runPromise(
      Effect.log('both').pipe(
        Effect.provide(
          Logger.layer([
            makePinoLogger(logger),
            Logger.make(({ message }) => seen.push(message)),
          ]),
        ),
      ),
    )
    expect(records.map(({ msg }) => msg)).toEqual(['both'])
    expect(seen).toEqual([['both']])
  })
})
