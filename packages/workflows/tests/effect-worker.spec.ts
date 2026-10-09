import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  defineTask,
  implementTask,
  runWorkflowWorker,
  serveExecutionWorker,
} from '../src/effect/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
} from '../src/runtime/index.ts'

class Multiplier extends Context.Service<Multiplier, number>()(
  'test/effect-worker/Multiplier',
) {}

const task = defineTask({
  name: 'effect-worker.task',
  input: Schema.Number,
  output: Schema.Number,
})

describe('standalone Effect workers', () => {
  it('serve work with ambient services until interrupted', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(adapter)
    const implementation = implementTask(task, {
      pool: 'test',
      handler: (input) =>
        Effect.gen(function* () {
          const multiplier = yield* Multiplier
          return input * multiplier
        }),
    })
    const serving = Effect.runFork(
      serveExecutionWorker({
        ...adapter,
        workflows: [],
        tasks: [implementation],
        workerId: 'serve',
        idleDelayMs: 5,
      }).pipe(Effect.provideService(Multiplier, 3)),
    )
    try {
      const run = await client.start(task, 2)
      await expect
        .poll(async () => (await client.get(run.id))?.run)
        .toMatchObject({ status: 'completed', output: 6 })
      // Work done, the worker keeps serving rather than completing.
      expect(serving.pollUnsafe()).toBeUndefined()
    } finally {
      await Effect.runPromise(Fiber.interrupt(serving))
    }
    const exit = await Effect.runPromise(Fiber.await(serving))
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
      true,
    )
  })

  it('drains running handlers before their services are released', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(adapter)
    const order: string[] = []
    const started = Promise.withResolvers<void>()
    const implementation = implementTask(task, {
      pool: 'test',
      handler: () =>
        Effect.gen(function* () {
          yield* Multiplier
          started.resolve()
          return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.sleep('10 millis').pipe(
              Effect.andThen(Effect.sync(() => order.push('handler'))),
            ),
          ),
        ),
    })
    const services = Layer.effect(
      Multiplier,
      Effect.acquireRelease(Effect.succeed(1), () =>
        Effect.sync(() => order.push('services')),
      ),
    )
    const run = await client.start(task, 1)
    const serving = Effect.runFork(
      serveExecutionWorker({
        ...adapter,
        workflows: [],
        tasks: [implementation],
        workerId: 'drain',
      }).pipe(Effect.provide(services)),
    )
    await started.promise
    await Effect.runPromise(Fiber.interrupt(serving))
    expect(order).toEqual(['handler', 'services'])
    // Shutdown hands the attempt back for redelivery instead of failing it.
    expect((await client.get(run.id))?.run.status).not.toBe('failed')
  })

  it('reports engine errors through the Effect logger', async () => {
    const adapter = createInMemoryWorkflowRuntime()
    const failure = new Error('maintenance failed')
    const logs: Logger.Options<unknown>[] = []
    const logger = Logger.make((options) => {
      logs.push(options)
    })
    const result = await Effect.runPromise(
      runWorkflowWorker({
        ...adapter,
        workflows: [],
        workerId: 'logging',
        reaping: false,
        runTimeouts: false,
        maintenance: [
          {
            everyMs: 60_000,
            run: () => Promise.reject(failure),
          },
        ],
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(result).toEqual({ processed: 0 })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.logLevel).toBe('Error')
    expect(logs[0]!.message).toEqual(['Workflow worker error'])
    expect(Cause.squash(logs[0]!.cause)).toBe(failure)
  })
})
