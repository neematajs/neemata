import { MessageChannel } from 'node:worker_threads'

import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'

import {
  createHandlerRuntime,
  defineTask,
  implementTask,
  runExecutionWorker,
  WorkflowHandlerError,
} from '../src/effect/index.ts'
import { defineWorkflows, defineWorkflowsWorker } from '../src/neem/index.ts'
import { WorkflowCleanupTimeoutError } from '../src/runtime/handler.ts'
import {
  createHandlerRunner,
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker as runStoredExecutionWorker,
} from '../src/runtime/index.ts'

const task = defineTask({
  name: 'effect-task',
  input: Schema.NumberFromString,
  output: Schema.NumberFromString,
  retry: { attempts: 2 },
})

const failures = {
  typed: () => Effect.fail(new Error('typed failure')),
  defect: () => Effect.die(new Error('defect')),
  promise: () =>
    Effect.promise(() => Promise.reject(new Error('promise defect'))),
  interruption: () => Effect.interrupt,
  mixed: () =>
    Effect.failCause(
      Cause.combine(Cause.fail(new Error('mixed failure')), Cause.interrupt()),
    ),
}

describe('Effect workflow execution', () => {
  it.each(Object.entries(failures))(
    'counts %s as an attempt failure and retries',
    async (_name, fail) => {
      let calls = 0
      let finalized = 0
      const implementation = implementTask(task, {
        handler: (input) =>
          Effect.suspend(() =>
            ++calls === 1 ? fail() : Effect.succeed(input + 1),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                finalized++
              }),
            ),
          ),
      })
      const runtime = createInMemoryWorkflowRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(task, 7)
      await runExecutionWorker({
        ...runtime,
        context: Context.empty(),
        tasks: [implementation],
        workflows: [],
        workerId: 'effects',
      })
      const snapshot = (await client.get(run.id))!
      expect(snapshot.run).toMatchObject({
        status: 'completed',
        input: '7',
        output: '8',
      })
      expect(snapshot.attempts.map(({ status }) => status)).toEqual([
        'failed',
        'completed',
      ])
      expect(calls).toBe(2)
      expect(finalized).toBe(2)
    },
  )

  it('does not invoke a handler when its engine signal is already aborted', async () => {
    const abort = new AbortController()
    const reason = new Error('attempt already cancelled')
    abort.abort(reason)
    const onFatal = vi.fn()
    const handlers = createHandlerRunner({ onFatal })
    const handler = vi.fn(() => 1)

    await expect(handlers.run(handler, abort.signal)).rejects.toBe(reason)
    await handlers.drain()
    expect(handler).not.toHaveBeenCalled()
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('retains mixed Cause contents instead of treating any interrupt as cancellation', async () => {
    const handlers = createHandlerRuntime(Context.empty())
    const cause = Cause.combine(
      Cause.die(new Error('cleanup failed')),
      Cause.interrupt(),
    )
    const failure = await handlers
      .run(() => Effect.failCause(cause), new AbortController().signal)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowHandlerError)
    if (!(failure instanceof WorkflowHandlerError))
      throw new Error('Expected structured Cause')
    expect(failure.cause.reasons.map(({ _tag }) => _tag)).toEqual([
      'Die',
      'Interrupt',
    ])
  })

  it('rejects invalid decoded input before metadata callbacks run', async () => {
    const tags = vi.fn(() => ({}))
    const checked = defineTask({
      name: 'checked',
      input: Schema.NumberFromString.check(Schema.isGreaterThan(0)),
      output: Schema.Number,
      tags,
    })
    const runtime = createInMemoryWorkflowRuntime()
    await expect(
      createWorkflowRuntimeClient(runtime).start(checked, -1),
    ).rejects.toThrow('Invalid task input')
    expect(tags).not.toHaveBeenCalled()
    expect(runtime.inspect().runs).toHaveLength(0)
  })

  it('waits for scoped cleanup after timeout and fences a late success', async () => {
    const timed = defineTask({
      name: 'timed',
      input: Schema.Number,
      output: Schema.Number,
      timeout: '10ms',
    })
    const cleanup = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const implementation = implementTask(timed, {
      handler: () =>
        Effect.uninterruptible(Effect.promise(() => release.promise)).pipe(
          Effect.as(99),
          Effect.ensuring(Effect.sync(() => cleanup.resolve())),
        ),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(timed, 1)
    const fatal = Promise.withResolvers<unknown>()
    const handlers = createHandlerRunner({
      cleanupTimeoutMs: 10,
      onFatal: fatal.resolve,
    })
    const running = runStoredExecutionWorker({
      ...runtime,
      handlers,
      env: createHandlerRuntime(Context.empty()),
      tasks: [implementation],
      workflows: [],
      workerId: 'timeout',
    })
    const failed = expect(running).rejects.toBeInstanceOf(
      WorkflowCleanupTimeoutError,
    )
    try {
      expect(await fatal.promise).toBeInstanceOf(WorkflowCleanupTimeoutError)
      await failed
      expect((await client.get(run.id))?.run.output).toBeUndefined()
    } finally {
      release.resolve()
      await handlers.drain()
    }
    await cleanup.promise
    expect((await client.get(run.id))?.run.output).toBeUndefined()
  })

  it('uses the engine cancellation reason even when a finalizer also fails', async () => {
    const started = Promise.withResolvers<void>()
    let reason: unknown
    const implementation = implementTask(task, {
      handler: (_input, lifecycle) =>
        Effect.gen(function* () {
          lifecycle!.signal.addEventListener(
            'abort',
            () => {
              reason = lifecycle!.signal.reason
            },
            { once: true },
          )
          started.resolve()
          return yield* Effect.never
        }).pipe(Effect.ensuring(Effect.die(new Error('finalizer defect')))),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(task, 1)
    const running = runExecutionWorker({
      ...runtime,
      context: Context.empty(),
      tasks: [implementation],
      workflows: [],
      workerId: 'cancel',
      leaseMs: 15,
    })
    await started.promise
    await client.cancel(run.id)
    await running
    expect(reason).toMatchObject({ type: 'cancelled' })
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('cancelled')
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.run.output).toBeUndefined()
  })

  it('releases a lease-lost attempt without committing its late success', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(task, 1)
    const released = Promise.withResolvers<void>()
    const implementation = implementTask(task, {
      handler: () =>
        Effect.uninterruptible(Effect.promise(() => released.promise)).pipe(
          Effect.as(99),
        ),
    })
    const attemptExecutor = {
      ...runtime.attemptExecutor,
      heartbeat: async () => {
        released.resolve()
        throw new Error('Workflow attempt heartbeat lease lost')
      },
    }
    const claimed = await attemptExecutor.claim({
      workerId: 'lease',
      workflowNames: [],
      activityNames: [],
      taskNames: [task.name],
      leaseMs: 15,
    })
    if (!claimed) throw new Error('Expected attempt')
    const { runTaskAttempt } = await import('../src/runtime/index.ts')
    await expect(
      runTaskAttempt({
        ...runtime,
        attemptExecutor,
        handlers: createHandlerRunner(),
        env: createHandlerRuntime(Context.empty()),
        claimed,
        tasks: [implementation],
        workerId: 'lease',
        leaseMs: 15,
      }),
    ).rejects.toThrow('lease lost')
    expect((await client.get(run.id))?.run.output).toBeUndefined()
  })
})

it.each([false, true])(
  'drains handlers before Layer release (cleanup overrun: %s)',
  async (overrun) => {
    const events: string[] = []
    const resource = Context.Service<{ touch: () => void }>('test-resource')
    const layer = Layer.effect(
      resource,
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push('acquire')
          return { touch: () => events.push('touch') }
        }),
        () =>
          Effect.sync(() => {
            events.push('release')
          }),
      ),
    )
    const started = Promise.withResolvers<void>()
    const finalizing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const implementation = implementTask(task, {
      handler: () =>
        Effect.gen(function* () {
          const service = yield* resource
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              finalizing.resolve()
              await release.promise
              service.touch()
              events.push('handler-finalized')
            }),
          )
          started.resolve()
          yield* Effect.never
          return 1
        }),
    })
    const adapter = createInMemoryWorkflowRuntime()
    await createWorkflowRuntimeClient(adapter).start(task, 1)
    const config = defineWorkflows({
      layer,
      runtime: Effect.succeed(adapter),
      workflows: () => [],
      tasks: () => [implementation],
      workers: {
        execution: {
          pollIntervalMs: 1,
          cleanupTimeoutMs: overrun ? 10 : 1_000,
        },
      },
    })
    const worker = defineWorkflowsWorker(config)
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'effects',
      data: { role: 'execution' },
      definition: worker.definition,
      logger: pino({ enabled: false }),
      port: channel.port1,
    })
    let stopping: Promise<unknown> | undefined
    try {
      await runtime.start()
      await started.promise
      const finished = overrun
        ? expect(runtime.finished).rejects.toBeInstanceOf(
            WorkflowCleanupTimeoutError,
          )
        : undefined
      stopping = Promise.resolve(runtime.stop()).catch(
        (error: unknown) => error,
      )
      await finalizing.promise
      if (finished) await finished
      expect(events).toEqual(['acquire'])
      release.resolve()
      await stopping
      expect(events).toEqual([
        'acquire',
        'touch',
        'handler-finalized',
        'release',
      ])
    } finally {
      release.resolve()
      await stopping
      channel.port1.close()
      channel.port2.close()
    }
  },
)

it('keeps the cleanup deadline armed through Layer disposal', async () => {
  const finalizing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let disposed = false
  const layer = Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.promise(async () => {
        finalizing.resolve()
        await release.promise
        disposed = true
      }),
    ),
  )
  const worker = defineWorkflowsWorker(
    defineWorkflows({
      layer,
      runtime: Effect.sync(createInMemoryWorkflowRuntime),
      workflows: () => [],
      workers: { coordinator: { cleanupTimeoutMs: 10 } },
    }),
  )
  const channel = new MessageChannel()
  const runtime = await worker.createRuntime({
    mode: 'development',
    name: 'layer-cleanup',
    data: { role: 'coordinator' },
    definition: worker.definition,
    logger: pino({ enabled: false }),
    port: channel.port1,
  })
  let stopping: Promise<unknown> | undefined
  try {
    await runtime.start()
    const finished = expect(runtime.finished).rejects.toBeInstanceOf(
      WorkflowCleanupTimeoutError,
    )
    stopping = Promise.resolve(runtime.stop()).catch((error: unknown) => error)
    await finalizing.promise
    await finished
    expect(disposed).toBe(false)
    release.resolve()
    await stopping
    expect(disposed).toBe(true)
  } finally {
    release.resolve()
    await stopping
    channel.port1.close()
    channel.port2.close()
  }
})
