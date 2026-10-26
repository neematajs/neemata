import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

import type {
  AttemptInfo,
  AttemptResult,
  Instrumentation as Hooks,
} from '../src/index.ts'
import {
  Client,
  Instrumentation,
  StorageError,
  Store,
  task,
  workflow,
} from '../src/index.ts'
import { deployment, execute, serve } from './typed-support.ts'

const io = { pool: 'test', input: Schema.String, output: Schema.String }
const TRACE = { traceparent: '00-4bf92f3577b34da6-00f067aa0ba902b7-01' }

const instrumented =
  (hooks: Hooks) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Instrumentation, hooks)

describe('headers', () => {
  it.effect(
    'are kept with the run a start creates, and are not what makes a start the same',
    () => {
      const Echo = task({
        ...io,
        name: 'echo',
        idempotency: (input) => [input],
        handler: Effect.succeed,
      })
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const first = yield* Client.start(Echo, 'a', { headers: TRACE })
          // The same start again, with a trace context of its own.
          const again = yield* Client.start(Echo, 'a', {
            headers: { traceparent: 'other' },
          })
          expect(again.id).toBe(first.id)
          expect((yield* Client.get(first.id))!.run.headers).toStrictEqual(
            TRACE,
          )

          const plain = yield* Client.start(Echo, 'b')
          expect((yield* Client.get(plain.id))!.run).not.toHaveProperty(
            'headers',
          )
        }),
      )
    },
  )

  it.effect('are given to the runs a run starts', () => {
    const Echo = task({ ...io, name: 'echo', handler: Effect.succeed })
    const Flow = workflow({ ...io, name: 'flow' }, function* (w) {
      return yield* w.task('echo', Echo, { input: w.input })
    })
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Flow, 'a', { headers: TRACE })
        yield* serve({ workflows: [Flow], tasks: [Echo] })

        const records = yield* Client.get(run.id)
        expect(records!.run.status).toBe('completed')
        const childRunId = records!.children[0]!.childRunId!
        expect((yield* Client.get(childRunId))!.run.headers).toStrictEqual(
          TRACE,
        )
      }),
    )
  })

  it.effect('start nothing unless they are strings, and few enough', () => {
    const Echo = task({ ...io, name: 'echo', handler: Effect.succeed })
    const { provide, inspect } = deployment()

    return provide(
      Effect.gen(function* () {
        const malformed = yield* Effect.exit(
          Client.start(Echo, 'a', {
            headers: { count: 1 } as unknown as Record<string, string>,
          }),
        )
        const missing = yield* Effect.exit(
          Client.start(Echo, 'a', {
            headers: null as unknown as Record<string, string>,
          }),
        )
        const oversized = yield* Effect.exit(
          Client.start(Echo, 'a', { headers: { big: 'x'.repeat(8_192) } }),
        )
        for (const exit of [malformed, missing, oversized]) {
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        }
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })
})

describe('instrumentation', () => {
  it.effect('gives a restarted run the headers of its own start', () => {
    const Echo = task({ ...io, name: 'echo', handler: Effect.succeed })
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Echo, 'a', { headers: TRACE })
        yield* serve({ tasks: [Echo] })
        const restarted = yield* Client.restart(run.id, { definitions: [Echo] })

        expect((yield* Client.get(restarted.id))!.run.headers).toStrictEqual({
          restarted: 'yes',
        })
      }).pipe(
        instrumented({
          start: (request, next) =>
            next(request.headers ?? { restarted: 'yes' }),
        }),
      ),
    )
  })

  it.effect(
    'decides the headers of a run a start creates, and learns whether it did',
    () => {
      const Echo = task({
        ...io,
        name: 'echo',
        idempotency: (input) => [input],
        handler: Effect.succeed,
      })
      const { provide } = deployment()
      const starts: unknown[] = []

      return provide(
        Effect.gen(function* () {
          const first = yield* Client.start(Echo, 'a', {
            headers: { tenant: 'acme' },
          })
          yield* Client.start(Echo, 'a')

          expect(starts).toStrictEqual([
            {
              request: {
                kind: 'task',
                name: 'echo',
                headers: { tenant: 'acme' },
              },
              created: true,
            },
            { request: { kind: 'task', name: 'echo' }, created: false },
          ])
          expect((yield* Client.get(first.id))!.run.headers).toStrictEqual({
            tenant: 'acme',
            ...TRACE,
          })
        }).pipe(
          instrumented({
            start: (request, next) =>
              next({ ...request.headers, ...TRACE }).pipe(
                Effect.tap(({ created }) =>
                  Effect.sync(() => starts.push({ request, created })),
                ),
              ),
          }),
        ),
      )
    },
  )

  it.effect(
    'wraps every handler, which sees the headers and when its work was queued, due and claimed',
    () => {
      const seen: { attempt: AttemptInfo; span: string }[] = []
      const Echo = task({
        ...io,
        name: 'echo',
        handler: (input, attempt) =>
          Effect.gen(function* () {
            const span = yield* Effect.currentSpan
            seen.push({ attempt, span: span.name })
            return input
          }),
      })
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Echo, 'a', {
            headers: TRACE,
            startAt: 5_000,
          })
          yield* serve({ tasks: [Echo] })

          expect((yield* Client.get(run.id))!.run.status).toBe('completed')
          const [{ attempt, span }] = seen as [(typeof seen)[0]]
          expect(span).toBe('attempt echo')
          expect(attempt).toMatchObject({
            kind: 'task',
            name: 'echo',
            runId: run.id,
            attemptNumber: 1,
            deliveries: 1,
            headers: TRACE,
            createdAt: 0,
            availableAt: 5_000,
          })
          expect(attempt.claimedAt).toBeGreaterThanOrEqual(5_000)
        }).pipe(
          instrumented({
            handler: (attempt, run) =>
              Effect.withSpan(run, `attempt ${attempt.name}`),
          }),
        ),
      )
    },
  )

  it.effect('fails the attempt when the handler hook throws', () => {
    const Echo = task({ ...io, name: 'echo', handler: Effect.succeed })
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Echo, 'a')
        yield* serve({ tasks: [Echo] })

        expect((yield* Client.get(run.id))!.run).toMatchObject({
          status: 'failed',
          error: { message: 'malformed traceparent' },
        })
      }).pipe(
        instrumented({
          handler: () => {
            throw new Error('malformed traceparent')
          },
        }),
      ),
    )
  })

  it.effect('is told how every attempt that began ended', () => {
    const Flaky = task({
      ...io,
      name: 'flaky',
      retry: { attempts: 2 },
      handler: (input, { attemptNumber }) =>
        attemptNumber === 1
          ? Effect.fail(new Error('once'))
          : Effect.succeed(input),
    })
    const Broken = task({
      ...io,
      name: 'broken',
      handler: () => Effect.fail(new Error('always')),
    })
    const Slow = task({
      ...io,
      name: 'slow',
      timeout: '1s',
      handler: () => Effect.never,
    })
    const { provide } = deployment()
    const ended: [string, number, AttemptResult][] = []

    return provide(
      Effect.gen(function* () {
        yield* Client.start(Flaky, 'a')
        yield* Client.start(Broken, 'b')
        yield* Client.start(Slow, 'c')
        yield* serve({ tasks: [Flaky, Broken, Slow] })

        const of = (name: string) =>
          ended
            .filter(([task]) => task === name)
            .map(([, attemptNumber, result]) => [attemptNumber, result])
        expect(of('flaky')).toMatchObject([
          [
            1,
            {
              kind: 'settlement',
              execution: 'failed',
              settlement: 'retrying',
              error: { message: 'once' },
            },
          ],
          [
            1 + 1,
            {
              kind: 'settlement',
              execution: 'completed',
              settlement: 'settled',
            },
          ],
        ])
        expect(of('broken')).toMatchObject([
          [
            1,
            {
              kind: 'settlement',
              execution: 'failed',
              settlement: 'settled',
              error: { message: 'always' },
            },
          ],
        ])
        expect(of('slow')).toMatchObject([
          [
            1,
            {
              kind: 'settlement',
              execution: 'timedOut',
              settlement: 'settled',
              error: { name: 'AttemptTimeout' },
            },
          ],
        ])
      }).pipe(
        instrumented({
          attemptEnded: (attempt, result) =>
            Effect.sync(() =>
              ended.push([attempt.name, attempt.attemptNumber, result]),
            ),
        }),
      ),
    )
  })

  it.effect(
    'is told of an attempt its worker stopped, and of one the store failed',
    () => {
      // The store fails the commit after the handler's first run once: the
      // outcome it would have settled.
      let failNext = false
      const Endless = task({
        ...io,
        name: 'endless',
        handler: () => Effect.never,
      })
      const Echo = task({
        ...io,
        name: 'echo',
        handler: (input, { deliveries }) =>
          Effect.sync(() => {
            if (deliveries === 1) failNext = true
            return input
          }),
      })
      const { provide, store } = deployment()
      const broken = Store.of({
        ...store,
        transact: (scope, plan) =>
          Effect.suspend(() => {
            if (!failNext) return store.transact(scope, plan)
            failNext = false
            return Effect.fail(new StorageError({ cause: 'connection reset' }))
          }),
      })
      const ended: [string, AttemptResult][] = []

      return provide(
        Effect.gen(function* () {
          yield* Client.start(Endless, 'a')
          yield* Client.start(Echo, 'b')
          // Execution workers alone: no sweep commits in between.
          yield* execute({ tasks: [Endless, Echo] }, 5_000)

          expect(ended).toMatchObject([
            ['echo', { kind: 'error', error: 'storage' }],
            ['echo', { kind: 'settlement', execution: 'completed' }],
            ['endless', { kind: 'stopped', reason: 'shutdown' }],
          ])
        }).pipe(
          Effect.provideService(Store, broken),
          instrumented({
            attemptEnded: (attempt, result) =>
              Effect.sync(() => ended.push([attempt.name, result])),
          }),
        ),
      )
    },
  )

  it.effect(
    'is told of an attempt its run stopped wanting, and changes nothing when it fails',
    () => {
      const Endless = task({
        ...io,
        name: 'endless',
        handler: () => Effect.never,
      })
      const Echo = task({ ...io, name: 'echo', handler: Effect.succeed })
      const { provide } = deployment()
      const ended: AttemptResult[] = []

      return provide(
        Effect.gen(function* () {
          const endless = yield* Client.start(Endless, 'a')
          const echo = yield* Client.start(Echo, 'b')
          yield* Effect.forkChild(
            Effect.andThen(Effect.sleep(5_000), Client.cancel(endless.id)),
          )
          yield* serve({ tasks: [Endless, Echo] })

          expect(ended).toStrictEqual([
            {
              kind: 'settlement',
              execution: 'completed',
              settlement: 'settled',
            },
            { kind: 'stopped', reason: 'cancelled' },
          ])
          expect((yield* Client.get(endless.id))!.run.status).toBe('cancelled')
          expect((yield* Client.get(echo.id))!.run.status).toBe('completed')
        }).pipe(
          instrumented({
            attemptEnded: (_attempt, result) =>
              Effect.andThen(
                Effect.sync(() => ended.push(result)),
                Effect.die('instrumentation is broken'),
              ),
          }),
        ),
      )
    },
  )
})
