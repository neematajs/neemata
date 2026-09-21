import { MessageChannel } from 'node:worker_threads'

import {
  isNeemRuntimeDeclaration,
  isNeemRuntimeHostFactory,
  isNeemRuntimeWorker,
} from '@nmtjs/neem'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/effect/index.ts'
import { defineWorkflowsWorker } from '../src/effect/neem.ts'
import { defineSchedule } from '../src/index.ts'
import workflowsHost from '../src/neem/host.ts'
import {
  createWorkflowsRuntime,
  defineWorkflowsPlanner,
} from '../src/neem/index.ts'
import {
  resolveWorkflowsPlan,
  resolveWorkflowsRegistry,
} from '../src/neem/runtime.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  type WorkflowRuntimeAdapter,
} from '../src/runtime/index.ts'
import { fromPromise } from './support/effect.ts'

describe('workflows Neem integration', () => {
  const logger = pino({ enabled: false })
  const io = Schema.Struct({ id: Schema.String })

  const workflow = defineWorkflow({
    name: 'neem.integration.empty',
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  }).build()
  const workflowImpl = implementWorkflow(workflow, { pool: 'test' }).finish(
    (_outputs, input) => fromPromise(() => ({ id: input.id })),
  )

  it('creates a marked Neem runtime declaration', () => {
    const defineRuntime = createWorkflowsRuntime()
    const declaration = defineRuntime({
      name: 'workflows',
      planner: './neem.planner.ts',
      worker: { entry: './neem.worker.ts' },
    })

    expect(isNeemRuntimeDeclaration(declaration)).toBe(true)
    expect(declaration.host?.entry).toBe('@nmtjs/workflows/neem/host')
  })

  const plannerContext = {
    mode: 'development',
    name: 'workflows',
    logger,
  } as const

  it('plans coordinator and pool threads with their settings', async () => {
    const planner = defineWorkflowsPlanner(() => ({
      coordinator: { threads: 2, concurrency: 3 },
      pools: {
        io: {},
        pdf: { threads: 2, concurrency: 1, cleanupTimeoutMs: 1_000 },
      },
    }))
    const plan = await planner(plannerContext)

    const pools = ['io', 'pdf']
    const defaults = { leaseMs: 30_000, pollIntervalMs: 250 }
    const coordinator = {
      role: 'coordinator',
      settings: { ...defaults, concurrency: 3, cleanupTimeoutMs: 5_000 },
      pools,
    }
    const pdf = {
      role: 'execution',
      pool: 'pdf',
      settings: { ...defaults, concurrency: 1, cleanupTimeoutMs: 1_000 },
      pools,
    }
    expect(plan.workers).toStrictEqual({
      coordinator: [coordinator, coordinator],
      execution: [
        {
          role: 'execution',
          pool: 'io',
          settings: { ...defaults, concurrency: 1, cleanupTimeoutMs: 5_000 },
          pools,
        },
        pdf,
        pdf,
      ],
    })
    expect(Object.keys(plan.options!.pools)).toStrictEqual(pools)
  })

  it('requires the planner to declare its execution pools', async () => {
    await expect(
      defineWorkflowsPlanner(() => ({ pools: {} }))(plannerContext),
    ).rejects.toThrow(
      'Workflows planner must declare at least one execution pool',
    )
  })

  it('rejects invalid thread counts and unnamed pools', async () => {
    await expect(
      defineWorkflowsPlanner(() => ({
        coordinator: { threads: 0 },
        pools: { io: {} },
      }))(plannerContext),
    ).rejects.toThrow('Invalid workflows worker thread count for coordinator')
    await expect(
      defineWorkflowsPlanner(() => ({ pools: { pdf: { threads: 1.5 } } }))(
        plannerContext,
      ),
    ).rejects.toThrow(
      'Invalid workflows worker thread count for execution pool [pdf]',
    )
    await expect(
      defineWorkflowsPlanner(() => ({ pools: { '': {} } }))(plannerContext),
    ).rejects.toThrow('Workflows execution pool requires a name')
  })

  const pooledWorkflow = defineWorkflow({
    name: 'neem.integration.pooled',
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  })
    .activity('fast', { input: io, output: io })
    .activity('slow', { input: io, output: io })
    .build()
  const pooledTask = defineTask({
    name: 'neem.integration.pooled-task',
    input: io,
    output: io,
  })
  const pooledTaskImpl = implementTask(pooledTask, {
    pool: 'heavy',
    handler: (input) => Effect.succeed(input),
  })
  const pooledImpl = implementWorkflow(pooledWorkflow, { pool: 'light' })
    .fast((input) => Effect.succeed(input), {
      input: (_outputs, input) => input,
    })
    .slow((input) => Effect.succeed(input), { input: ({ fast }) => fast })
    .finish(({ slow }) => Effect.succeed(slow))

  it('rejects an implementation that names a pool the planner did not declare', async () => {
    const registry = {
      workflows: () => [pooledImpl],
      tasks: () => [pooledTaskImpl],
    }
    await expect(
      resolveWorkflowsRegistry(registry, {
        role: 'execution',
        pool: 'light',
        pools: ['light', 'heavvy'],
      }),
    ).rejects.toThrow(
      'Execution pools [heavy] named by implementations are not declared by the workflows planner',
    )
    await expect(
      resolveWorkflowsRegistry(registry, {
        role: 'coordinator',
        pools: ['light', 'heavy'],
      }),
    ).resolves.toBeDefined()
    // Hand-written worker data carries no declared pools to check against.
    await expect(
      resolveWorkflowsRegistry(registry, { role: 'execution' }),
    ).resolves.toBeDefined()
  })

  it('fails worker startup for an undeclared pool', async () => {
    const worker = defineWorkflowsWorker({
      workflows: () => [pooledImpl],
      tasks: () => [pooledTaskImpl],
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
    })
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:execution:0',
      data: { role: 'execution', pool: 'light', pools: ['light'] },
      logger,
      definition: worker.definition,
      port: channel.port1,
    })

    await expect(runtime.start()).rejects.toThrow('Execution pools [heavy]')
    await runtime.stop()
    channel.port1.close()
    channel.port2.close()
  })

  it('rejects child workflows without a registered implementation', async () => {
    const child = defineWorkflow({
      name: 'neem.integration.unregistered-child',
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    }).build()
    const parent = defineWorkflow({
      name: 'neem.integration.parent-with-unregistered-child',
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    })
      .workflow('child', child)
      .build()
    const parentImpl = implementWorkflow(parent, { pool: 'test' })
      .child(child)
      .finish(() => fromPromise(() => ({})))

    await expect(
      resolveWorkflowsRegistry(
        { workflows: () => [parentImpl] },
        { role: 'coordinator' },
      ),
    ).rejects.toThrow(
      `Workflows [${child.name}] referenced by registered workflows have no registered implementation`,
    )
  })

  it('rejects workflows that start each other in a cycle', async () => {
    // Definitions cannot reference each other as objects, but children resolve
    // by name: a same-named definition closes the loop.
    const aStub = defineWorkflow({
      name: 'neem.integration.cycle.a',
      input: io,
      output: io,
    }).build()
    const b = defineWorkflow({
      name: 'neem.integration.cycle.b',
      input: io,
      output: io,
    })
      .workflow('next', aStub)
      .build()
    const a = defineWorkflow({
      name: 'neem.integration.cycle.a',
      input: io,
      output: io,
    })
      .workflow('next', b)
      .build()
    const aImpl = implementWorkflow(a, { pool: 'test' })
      .next(b, { input: (_outputs, input) => input })
      .finish(({ next }) => Effect.succeed(next))
    const bImpl = implementWorkflow(b, { pool: 'test' })
      .next(aStub, { input: (_outputs, input) => input })
      .finish(({ next }) => Effect.succeed(next))

    await expect(
      resolveWorkflowsRegistry(
        { workflows: () => [aImpl, bImpl] },
        { role: 'coordinator' },
      ),
    ).rejects.toThrow(
      'Workflows [neem.integration.cycle.a -> neem.integration.cycle.b -> neem.integration.cycle.a] start each other in a cycle',
    )
  })

  it('rejects recursion through a branch case as well', async () => {
    const leaf = defineWorkflow({
      name: 'neem.integration.recursive',
      input: io,
      output: io,
    }).build()
    const recursive = defineWorkflow({
      name: 'neem.integration.recursive',
      input: io,
      output: io,
    })
      .branch('step', {
        output: io,
        cases: (h) => ({
          done: h.activity({ input: io, output: io }),
          deeper: h.workflow(leaf),
        }),
      })
      .build()
    const recursiveImpl = implementWorkflow(recursive, { pool: 'test' })
      .step({
        select: (_outputs, input) => (input.id === '' ? 'done' : 'deeper'),
        cases: ({ activity, workflow }) => ({
          done: activity((input) => Effect.succeed(input), {
            input: (_outputs, input) => input,
          }),
          deeper: workflow(leaf, { input: () => ({ id: '' }) }),
        }),
      })
      .finish(({ step }) => Effect.succeed(step))

    await expect(
      resolveWorkflowsRegistry(
        { workflows: () => [recursiveImpl] },
        { role: 'coordinator' },
      ),
    ).rejects.toThrow(
      'Workflows [neem.integration.recursive -> neem.integration.recursive] start each other in a cycle',
    )
  })

  it('rejects workflow tasks without a registered implementation', async () => {
    const parent = defineWorkflow({
      name: 'neem.integration.parent-with-unregistered-task',
      input: io,
      output: io,
    })
      .task('work', pooledTask)
      .build()
    const parentImpl = implementWorkflow(parent, { pool: 'test' })
      .work(pooledTask, { input: (_outputs, input) => input })
      .finish(({ work }) => Effect.succeed(work))

    await expect(
      resolveWorkflowsRegistry(
        { workflows: () => [parentImpl] },
        { role: 'coordinator' },
      ),
    ).rejects.toThrow(
      `Tasks [${pooledTask.name}] referenced by registered workflows have no registered implementation`,
    )
  })

  it('creates and stops a worker runtime and disposes the adapter', async () => {
    const dispose = vi.fn()
    const config = {
      workflows: () => [workflowImpl],
    }
    const worker = defineWorkflowsWorker({
      ...config,
      runtime: Effect.sync(() => ({
        ...createInMemoryWorkflowRuntime(),
        dispose,
      })),
    })
    const channel = new MessageChannel()

    expect(isNeemRuntimeWorker(worker)).toBe(true)

    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:coordinator:0',
      data: { role: 'coordinator', settings: { pollIntervalMs: 1 } },
      logger,
      definition: worker.definition,
      port: channel.port1,
    })

    await runtime.start()
    await runtime.stop()
    await expect(runtime.finished).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()
    channel.port1.close()
    channel.port2.close()
  })

  it('shares one startup while the workflow definitions are resolving', async () => {
    const definitions = Promise.withResolvers<void>()
    const workflows = vi.fn(async () => {
      await definitions.promise
      return []
    })
    const acquire = vi.fn(createInMemoryWorkflowRuntime)
    const worker = defineWorkflowsWorker({
      workflows,
      runtime: Effect.sync(acquire),
    })
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'concurrent-start',
      data: { role: 'coordinator', settings: { pollIntervalMs: 1 } },
      logger,
      definition: worker.definition,
      port: channel.port1,
    })
    const first = runtime.start()
    const second = runtime.start()
    try {
      expect(first).toBe(second)
      expect(workflows).toHaveBeenCalledOnce()
      definitions.resolve()
      await Promise.all([first, second])
      expect(acquire).toHaveBeenCalledOnce()
    } finally {
      definitions.resolve()
      await Promise.allSettled([first, second])
      await runtime.stop()
      channel.port1.close()
      channel.port2.close()
    }
  })

  it.each([false, true])(
    'settles finished when stopped before a fiber exists (start pending: %s)',
    async (startPending) => {
      const definitions = Promise.withResolvers<void>()
      const acquire = vi.fn(createInMemoryWorkflowRuntime)
      const worker = defineWorkflowsWorker({
        workflows: async () => {
          await definitions.promise
          return []
        },
        runtime: Effect.sync(acquire),
      })
      const channel = new MessageChannel()
      const runtime = await worker.createRuntime({
        mode: 'development',
        name: 'stop-before-fiber',
        data: { role: 'coordinator', settings: { pollIntervalMs: 1 } },
        logger,
        definition: worker.definition,
        port: channel.port1,
      })
      const finished = vi.fn()
      void runtime.finished?.then(finished)
      const starting = startPending
        ? expect(runtime.start()).rejects.toThrow('Workflows worker stopped')
        : undefined
      try {
        await runtime.stop()
        expect(finished).toHaveBeenCalledOnce()
        await starting
        await expect(runtime.start()).rejects.toThrow(
          'Workflows worker stopped',
        )
      } finally {
        definitions.resolve()
        await starting
        await runtime.stop()
        channel.port1.close()
        channel.port2.close()
      }
      expect(acquire).not.toHaveBeenCalled()
    },
  )

  it('stops promptly by delivering shutdown to an in-flight task handler', async () => {
    const task = defineTask({
      name: 'neem.integration.shutdown-task',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
    let shutdownReason: unknown
    let handlerStarted!: () => void
    const handlerStartedPromise = new Promise<void>((resolve) => {
      handlerStarted = resolve
    })
    const taskImpl = implementTask(task, {
      pool: 'test',
      handler: (input, lifecycle) =>
        fromPromise(async () => {
          handlerStarted()
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 300)
            lifecycle?.signal.addEventListener(
              'abort',
              () => {
                shutdownReason = lifecycle.signal.reason
                clearTimeout(timeout)
                resolve()
              },
              { once: true },
            )
          })
          return { text: `late:${input.text}` }
        }),
    })
    const runtimeAdapter = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtimeAdapter)
    const run = await client.start(task, { text: 'alpha' })
    const config = {
      workflows: () => [],
      tasks: () => [taskImpl],
    }
    const worker = defineWorkflowsWorker({
      ...config,
      runtime: Effect.sync(() => runtimeAdapter),
    })
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:execution:shutdown',
      data: { role: 'execution', settings: { pollIntervalMs: 1, leaseMs: 30 } },
      logger,
      definition: worker.definition,
      port: channel.port1,
    })

    try {
      await runtime.start()
      await handlerStartedPromise
      const startedStoppingAt = Date.now()
      await runtime.stop()
      const stopElapsedMs = Date.now() - startedStoppingAt
      const snapshot = await runtimeAdapter.store.loadRunSnapshot(run.id)

      expect(stopElapsedMs).toBeLessThan(150)
      expect(shutdownReason).toMatchObject({ type: 'shutdown' })
      expect(snapshot?.run.status).toBe('running')
      expect(snapshot?.attempts[0]?.status).toBe('started')
      expect(runtimeAdapter.inspect().taskCommands).toHaveLength(1)
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  it('logs worker-loop failures immediately and rethrows them on stop', async () => {
    const failure = new Error('coordinator claim failed')
    const errorSpy = vi.spyOn(logger, 'error')
    const baseRuntime = createInMemoryWorkflowRuntime()
    const brokenRuntime = {
      ...baseRuntime,
      runCoordinationExecutor: {
        ...baseRuntime.runCoordinationExecutor,
        claim: async () => {
          throw failure
        },
      },
    } satisfies WorkflowRuntimeAdapter
    const config = {
      workflows: () => [workflowImpl],
    }
    const worker = defineWorkflowsWorker({
      ...config,
      runtime: Effect.sync(() => brokenRuntime),
    })
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:coordinator:failure',
      data: { role: 'coordinator', settings: { pollIntervalMs: 1 } },
      logger,
      definition: worker.definition,
      port: channel.port1,
    })

    await runtime.start()
    await waitFor(() => (errorSpy.mock.calls.length > 0 ? true : undefined))
    await expect(runtime.finished).rejects.toThrow('coordinator claim failed')
    await expect(runtime.stop()).rejects.toThrow('coordinator claim failed')
    expect(errorSpy).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: expect.stringContaining(failure.message),
        }),
      },
      'Neem workflows worker loop failed',
    )
    channel.port1.close()
    channel.port2.close()
    errorSpy.mockRestore()
  })

  it('runs coordinator and execution role loops end-to-end', async () => {
    const disposePluginDependency = vi.fn()
    const beforeInitialize = vi.fn()
    const afterDispose = vi.fn()
    const pluginDependency = Context.Service<string>('test/plugin')
    const services = Layer.effect(
      pluginDependency,
      Effect.acquireRelease(
        Effect.sync(() => {
          beforeInitialize()
          return 'plugin'
        }),
        () =>
          Effect.sync(() => {
            disposePluginDependency()
            afterDispose()
          }),
      ),
    )
    const task = defineTask({
      name: 'neem.integration.task',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
    const fullWorkflow = defineWorkflow({
      name: 'neem.integration.full',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
      .activity('activity', {
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
      .task('task', task)
      .build()
    const taskImpl = implementTask(task, {
      pool: 'test',
      handler: (input) =>
        Effect.gen(function* () {
          const prefix = yield* pluginDependency
          return { text: `${prefix}:${input.text}:task` }
        }),
    })
    const fullWorkflowImpl = implementWorkflow(fullWorkflow, { pool: 'test' })
      .activity(
        (input) =>
          fromPromise(async () => ({ text: `${input.text}:activity` })),
        {
          input: (_outputs, input) => ({ text: input.text }),
        },
      )
      .task(task, {
        input: ({ activity }) => ({ text: activity.text }),
      })
      .finish(({ task }) => fromPromise(() => ({ text: task.text })))
    const runtimeAdapter = createInMemoryWorkflowRuntime()
    const config = {
      workflows: () => [fullWorkflowImpl],
      tasks: () => [taskImpl],
    }
    const worker = defineWorkflowsWorker({
      ...config,
      runtime: Effect.sync(() => runtimeAdapter),
      layer: services,
    })
    const runtimes = await Promise.all(
      (['coordinator', 'execution'] as const).map(async (role) => {
        const channel = new MessageChannel()
        const runtime = await worker.createRuntime({
          mode: 'development',
          name: `workflows:${role}:0`,
          data: { role, settings: { pollIntervalMs: 1 } },
          logger,
          definition: worker.definition,
          port: channel.port1,
        })
        return { channel, runtime }
      }),
    )
    const client = createWorkflowRuntimeClient(runtimeAdapter)
    const run = await client.start(fullWorkflow, { text: 'alpha' })

    try {
      await Promise.all(
        runtimes.map(({ runtime }) => Promise.resolve(runtime.start())),
      )
      const snapshot = await waitFor(async () => {
        const current = await runtimeAdapter.store.loadRunSnapshot(run.id)
        return current?.run.status === 'completed' ? current : undefined
      })
      expect(snapshot.run.output).toStrictEqual({
        text: 'plugin:alpha:activity:task',
      })
    } finally {
      await Promise.allSettled(
        runtimes.map(({ runtime }) => Promise.resolve(runtime.stop())),
      )
      for (const { channel } of runtimes) {
        channel.port1.close()
        channel.port2.close()
      }
    }

    expect(disposePluginDependency).toHaveBeenCalledTimes(2)
    expect(beforeInitialize).toHaveBeenCalledTimes(2)
    expect(afterDispose).toHaveBeenCalledTimes(2)
  })

  it('reconciles schedules once and fires them from coordinator workers', async () => {
    const runtimeAdapter = createInMemoryWorkflowRuntime()
    const schedule = defineSchedule({
      name: 'neem.integration.schedule',
      runnable: workflow,
      input: { id: 'scheduled' },
      every: '1h',
      immediately: true,
    })
    const config = {
      workflows: () => [workflowImpl],
      schedules: () => [schedule],
    }
    const worker = defineWorkflowsWorker({
      ...config,
      runtime: Effect.sync(() => runtimeAdapter),
    })
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:coordinator:schedule',
      data: { role: 'coordinator', settings: { pollIntervalMs: 1 } },
      logger,
      definition: worker.definition,
      port: channel.port1,
    })
    const client = createWorkflowRuntimeClient(runtimeAdapter)

    try {
      await runtime.start()
      const runs = await waitFor(async () => {
        const current = await client.list({
          tags: { schedule: schedule.name },
        })
        return current.runs[0]?.status === 'completed'
          ? current.runs
          : undefined
      })

      expect(runtimeAdapter.inspect().schedules).toMatchObject([
        { name: schedule.name },
      ])
      expect(runs[0]?.input).toStrictEqual({ id: 'scheduled' })
    } finally {
      await runtime.stop()
      channel.port1.close()
      channel.port2.close()
    }
  })

  it('starts and stops the lightweight host', async () => {
    expect(isNeemRuntimeHostFactory(workflowsHost)).toBe(true)
    const host = await workflowsHost({
      mode: 'development',
      name: 'workflows',
      logger,
      threads: [],
      options: resolveWorkflowsPlan({ pools: { io: {} } }),
    })

    await host.start?.()
    await host.stop?.()
  })
})

async function waitFor<T>(
  callback: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await callback()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}
