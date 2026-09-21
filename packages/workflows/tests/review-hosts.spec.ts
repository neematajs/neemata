import { MessageChannel } from 'node:worker_threads'

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { pino } from 'pino'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as z from 'zod'

import {
  defineWorkflow as defineEffectWorkflow,
  implementTask as implementEffectTask,
  implementWorkflow as implementEffectWorkflow,
  runExecutionWorker as runEffectExecutionWorker,
  runWorkflowWorker as runEffectWorkflowWorker,
  type HandlerRuntime,
  type Requirements,
} from '../src/effect/index.ts'
import { defineWorkflowsWorker as defineEffectWorkflowsWorker } from '../src/effect/neem.ts'
import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import { defineWorkflowsWorker } from '../src/neem/index.ts'
import {
  resolveWorkflowsRegistry,
  type WorkflowsWorkerData,
} from '../src/neem/runtime.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  WorkflowCleanupTimeoutError,
  type WorkflowRuntimeAdapter,
} from '../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../src/runtime/worker.ts'

const logger = pino({ enabled: false })

const workflow = defineEffectWorkflow({
  name: 'review.hosts.empty',
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String }),
}).build()
const workflowImpl = implementEffectWorkflow(workflow, { pool: 'test' }).finish(
  (_outputs, input) => Effect.succeed({ id: input.id }),
)
const schedule = defineSchedule({
  name: 'review.hosts.schedule',
  runnable: workflow,
  input: { id: 'scheduled' },
  every: '1h',
})

type Worker = {
  readonly definition: unknown
  readonly createRuntime: (ctx: any) => any
}

async function createCoordinator(worker: Worker) {
  const channel = new MessageChannel()
  const data: WorkflowsWorkerData = {
    role: 'coordinator',
    settings: { pollIntervalMs: 1, cleanupTimeoutMs: 5 },
  }
  const runtime = await worker.createRuntime({
    mode: 'development',
    name: 'workflows:coordinator:0',
    data,
    logger,
    definition: worker.definition,
    port: channel.port1,
  })
  return {
    runtime: runtime as {
      readonly finished: Promise<void>
      start(): Promise<unknown>
      stop(): Promise<void>
    },
    close: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

/** An adapter whose reconciliation fails and whose disposal hangs until released. */
function createHangingAdapter() {
  const released = Promise.withResolvers<void>()
  const adapter = createInMemoryWorkflowRuntime()
  const runtime: WorkflowRuntimeAdapter = {
    ...adapter,
    scheduler: {
      ...adapter.scheduler!,
      reconcile: () => Promise.reject(new Error('reconcile failed')),
    },
    dispose: () => released.promise,
  }
  return { runtime, release: () => released.resolve() }
}

const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
  ])

describe('worker startup cleanup deadline', () => {
  it('bounds a hanging adapter disposal after an Effect worker fails to start', async () => {
    const adapter = createHangingAdapter()
    const worker = defineEffectWorkflowsWorker({
      workflows: () => [workflowImpl],
      schedules: () => [schedule],
      runtime: Effect.sync(() => adapter.runtime),
    })
    const { runtime, close } = await createCoordinator(worker)

    try {
      const start = runtime.start()
      expect(await settled(start)).toBeInstanceOf(WorkflowCleanupTimeoutError)
      expect(await settled(runtime.finished)).toBeInstanceOf(
        WorkflowCleanupTimeoutError,
      )
    } finally {
      adapter.release()
      await runtime.stop().catch(() => {})
      close()
    }
  })

  it('bounds a hanging Layer finalizer after an Effect worker fails to start', async () => {
    const released = Promise.withResolvers<void>()
    const adapter = createHangingAdapter()
    const worker = defineEffectWorkflowsWorker({
      workflows: () => [workflowImpl],
      schedules: () => [schedule],
      runtime: Effect.sync(() => ({ ...adapter.runtime, dispose: () => {} })),
      layer: Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.promise(() => released.promise)),
      ),
    })
    const { runtime, close } = await createCoordinator(worker)

    try {
      const start = runtime.start()
      expect(await settled(start)).toBeInstanceOf(WorkflowCleanupTimeoutError)
      expect(await settled(runtime.finished)).toBeInstanceOf(
        WorkflowCleanupTimeoutError,
      )
    } finally {
      released.resolve()
      await runtime.stop().catch(() => {})
      close()
    }
  })

  it('bounds a hanging adapter disposal after a Promise worker fails to start', async () => {
    const adapter = createHangingAdapter()
    const core = defineWorkflow({
      name: 'review.hosts.core-empty',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
    }).build()
    const coreImpl = implementWorkflow(core, { pool: 'test' }).finish(
      (_outputs, input) => input,
    )
    const worker = defineWorkflowsWorker({
      workflows: () => [coreImpl],
      schedules: () => [
        defineSchedule({
          name: 'review.hosts.core-schedule',
          runnable: core,
          input: { id: 'scheduled' },
          every: '1h',
        }),
      ],
      setup: () => ({ runtime: adapter.runtime }),
    })
    const { runtime, close } = await createCoordinator(worker)

    try {
      const start = runtime.start()
      expect(await settled(start)).toBeInstanceOf(WorkflowCleanupTimeoutError)
      expect(await settled(runtime.finished)).toBeInstanceOf(
        WorkflowCleanupTimeoutError,
      )
    } finally {
      adapter.release()
      await runtime.stop().catch(() => {})
      close()
    }
  })
})

describe('core handlers in Effect workers', () => {
  class Service extends Context.Service<Service, { value: number }>()(
    'review/hosts/Service',
  ) {}
  type Db = { readonly db: { read(): number } }
  const io = { input: z.number(), output: z.number() }
  const task = defineTask({ name: 'review.hosts.core-task', ...io })
  const coreWorkflow = defineWorkflow({
    name: 'review.hosts.core-workflow',
    ...io,
  }).build()
  const runtime = Effect.sync(createInMemoryWorkflowRuntime)
  const layer = Layer.succeed(Service, { value: 1 })

  const needsDb = implementTask(task, {
    pool: 'test',
    handler: (_input, _lifecycle, env: Db) => env.db.read(),
  })
  const finishNeedsDb = implementWorkflow(coreWorkflow, {
    pool: 'test',
  }).finish((_outputs, _input, _lifecycle, env: Db) => env.db.read())
  const envless = implementTask(task, {
    pool: 'test',
    handler: (input) => input,
  })
  const usesRuntime = implementTask(task, {
    pool: 'test',
    handler: (_input, lifecycle, env: HandlerRuntime<Service>) =>
      env.run(
        () => Service.pipe(Effect.map(({ value }) => value)),
        lifecycle.signal,
      ),
  })
  const effectTask = implementEffectTask(task, {
    pool: 'test',
    handler: () => Service.pipe(Effect.map(({ value }) => value)),
  })

  it('rejects a core env that is not a handler runtime in the Neem worker', () => {
    expectTypeOf<Requirements<typeof envless>>().toEqualTypeOf<never>()
    expectTypeOf<Requirements<typeof usesRuntime>>().toEqualTypeOf<Service>()
    expectTypeOf<Requirements<typeof effectTask>>().toEqualTypeOf<Service>()
    expectTypeOf<Requirements<typeof needsDb>>().not.toEqualTypeOf<never>()

    const workflows = () => []
    // @ts-expect-error An Effect worker cannot pass the task its db.
    defineEffectWorkflowsWorker({ workflows, tasks: () => [needsDb], runtime })
    defineEffectWorkflowsWorker({
      workflows,
      tasks: () => [needsDb],
      runtime,
      // @ts-expect-error No Layer stands in for the env either.
      layer,
    })
    // @ts-expect-error Finish handlers are checked the same way.
    defineEffectWorkflowsWorker({ workflows: () => [finishNeedsDb], runtime })
    defineEffectWorkflowsWorker({
      workflows,
      tasks: () => [envless, effectTask, needsDb],
      runtime,
      // @ts-expect-error One incompatible handler fails a mixed list.
      layer,
    })

    expect(
      defineEffectWorkflowsWorker({
        workflows,
        tasks: () => [envless],
        runtime,
      }),
    ).toBeDefined()
    expect(
      defineEffectWorkflowsWorker({
        workflows,
        tasks: () => [envless, usesRuntime, effectTask],
        runtime,
        layer,
      }),
    ).toBeDefined()
    const erased: { workflows: () => any[]; tasks: () => any[] } = {
      workflows,
      tasks: () => [needsDb],
    }
    expect(defineEffectWorkflowsWorker({ ...erased, runtime })).toBeDefined()
  })

  it('rejects a core env that is not a handler runtime in standalone workers', () => {
    const worker = {
      ...createInMemoryWorkflowRuntime(),
      workflows: [],
      workerId: 'review-hosts',
    }
    const context = Context.make(Service, { value: 1 })
    // Thunks: only the call's types matter, the workers must not run.
    void (() =>
      // @ts-expect-error The context cannot carry the task's db.
      runEffectExecutionWorker({ ...worker, tasks: [needsDb], context }))
    void (() =>
      runEffectWorkflowWorker({
        ...worker,
        workflows: [finishNeedsDb],
        // @ts-expect-error Nor the finish handler's.
        context: Context.empty(),
      }))
    void (() =>
      runEffectExecutionWorker({
        ...worker,
        tasks: [envless],
        context: Context.empty(),
      }))
    void (() =>
      runEffectExecutionWorker({
        ...worker,
        tasks: [envless, usesRuntime, effectTask],
        context,
      }))
    const erased: any[] = [needsDb]
    void (() =>
      runEffectExecutionWorker({
        ...worker,
        tasks: erased,
        context: Context.empty(),
      }))
  })
})

describe('schedule targets in registry validation', () => {
  const io = { input: z.object({}), output: z.object({}) }
  const data = { role: 'coordinator' } as const
  const target = defineWorkflow({ name: 'review.hosts.target', ...io }).build()
  const targetImpl = implementWorkflow(target, { pool: 'test' }).finish(
    () => ({}),
  )
  const task = defineTask({ name: 'review.hosts.target-task', ...io })
  const taskImpl = implementTask(task, { pool: 'test', handler: () => ({}) })
  const every = { input: {}, every: '1h' } as const

  it('accepts schedules whose targets are registered', async () => {
    const schedules = [
      defineSchedule({ name: 'workflow', runnable: target, ...every }),
      defineSchedule({ name: 'task', runnable: task, ...every }),
    ]
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          tasks: () => [taskImpl],
          schedules: () => schedules,
        },
        data,
      ),
    ).resolves.toMatchObject({ schedules })
  })

  it('rejects a schedule whose task or workflow has no implementation', async () => {
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          schedules: () => [
            defineSchedule({ name: 'task', runnable: task, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(
      `[${task.name}] targeted by schedules have no registered implementation`,
    )
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [],
          tasks: () => [taskImpl],
          schedules: () => [
            defineSchedule({ name: 'workflow', runnable: target, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(
      `[${target.name}] targeted by schedules have no registered implementation`,
    )
  })

  it('rejects a schedule targeting a same-named copy of a registered definition', async () => {
    const taskCopy = defineTask({ name: task.name, ...io })
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          tasks: () => [taskImpl],
          schedules: () => [
            defineSchedule({ name: 'task', runnable: taskCopy, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(`Definitions [${task.name}] exist as more than one`)
    const targetCopy = defineWorkflow({ name: target.name, ...io }).build()
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          schedules: () => [
            defineSchedule({ name: 'copy', runnable: targetCopy, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(`Definitions [${target.name}] exist as more than one`)
  })
})

describe('in-memory adapter', () => {
  const io = { input: z.object({}), output: z.object({}) }
  const workflow = defineWorkflow({
    name: 'review.hosts.memory',
    ...io,
  }).build()
  const task = defineTask({ name: 'review.hosts.memory-task', ...io })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a manual retry when an unrelated attempt command is dead', async () => {
    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, {})
    const continuation = await runtime.runCoordinationExecutor.claim({
      workflowNames: [workflow.name],
      workerId: 'coordinator',
      leaseMs: 30_000,
    })
    await runtime.runCoordinationExecutor.release(continuation!, {
      error: new Error('dead'),
    })
    const staleBatch = await runtime.store.listUnreapedDeadCommands()
    expect(staleBatch).toHaveLength(1)
    await reapDeadWorkflowCommands(runtime)
    await client.retry(run.id)
    const retried = await client.get(run.id)
    expect(retried?.run.status).not.toBe('failed')

    await client.start(task, {})
    const attempt = await runtime.attemptExecutor.claim({
      workflowNames: [],
      taskNames: [task.name],
      workerId: 'execution',
      leaseMs: 30_000,
    })
    await runtime.attemptExecutor.release(attempt!, {
      error: new Error('dead'),
    })
    await expect(
      runtime.store.listUnreapedDeadCommands({ commandId: staleBatch[0]!.id }),
    ).resolves.toStrictEqual([])
    await expect(
      runtime.store.listUnreapedDeadCommands({ commandId: attempt!.id }),
    ).resolves.toMatchObject([{ id: attempt!.id, kind: 'task' }])

    // The reaper listed the continuation before the retry retired it.
    await reapDeadWorkflowCommands({
      ...runtime,
      store: {
        ...runtime.store,
        listUnreapedDeadCommands: (params) =>
          params?.commandId
            ? runtime.store.listUnreapedDeadCommands(params)
            : Promise.resolve(staleBatch),
      },
    })
    expect(await client.get(run.id)).toEqual(retried)
  })

  it('does not advance delays or leases with the number of operations', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const worker = {
      workflowNames: [workflow.name],
      workerId: 'coordinator',
      leaseMs: 100,
    }

    const leased = await client.start(workflow, {})
    const claimed = await runtime.runCoordinationExecutor.claim(worker)
    expect(claimed?.command.runId).toBe(leased.id)
    const delayed = await runtime.store.createRun({
      workflowName: workflow.name,
      input: {},
    })
    await runtime.runCoordinationExecutor.enqueueDelayed(
      { kind: 'continueRun', runId: delayed.id, workflowName: workflow.name },
      Date.now() + 100,
    )

    for (let index = 0; index < 150; index += 1)
      await runtime.store.createRun({ workflowName: 'unrelated', input: {} })

    // Neither the delay nor the lease has elapsed: no wall time has passed.
    expect(await runtime.runCoordinationExecutor.claim(worker)).toBeNull()
    vi.setSystemTime(Date.now() + 100)
    const due = [
      await runtime.runCoordinationExecutor.claim(worker),
      await runtime.runCoordinationExecutor.claim(worker),
    ]
    expect(new Set(due.map((command) => command?.command.runId))).toStrictEqual(
      new Set([leased.id, delayed.id]),
    )
  })

  it('orders records created within one millisecond by creation', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const created: string[] = []
    for (let index = 0; index < 12; index += 1)
      created.push((await client.start(task, {})).id)

    const listed = await client.list({ limit: 5 })
    expect(listed.runs.map((run) => run.id)).toStrictEqual(
      created.toReversed().slice(0, 5),
    )
    const next = await client.list({ limit: 5, cursor: listed.nextCursor })
    expect(next.runs.map((run) => run.id)).toStrictEqual(
      created.toReversed().slice(5, 10),
    )

    const claimedRunIds: string[] = []
    for (let index = 0; index < created.length; index += 1) {
      const attempt = await runtime.attemptExecutor.claim({
        workflowNames: [],
        taskNames: [task.name],
        workerId: 'execution',
        leaseMs: 30_000,
      })
      claimedRunIds.push(attempt!.command.runId)
    }
    expect(claimedRunIds).toStrictEqual(created)
  })
})
