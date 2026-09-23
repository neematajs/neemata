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
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import workflowsHost from '../src/neem/host.ts'
import {
  createWorkflowsRuntime,
  defineWorkflows,
  defineWorkflowsPlanner,
  defineWorkflowsWorker,
  type WorkflowsNamedExecutionWorkerPoolConfig,
} from '../src/neem/index.ts'
import { resolveWorkflowsConfig } from '../src/neem/runtime.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  type WorkflowRuntimeAdapter,
} from '../src/runtime/index.ts'
import { fromPromise } from './support/effect.ts'

describe('workflows Neem integration', () => {
  const logger = pino({ enabled: false })

  const workflow = defineWorkflow({
    name: 'neem.integration.empty',
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  }).build()
  const workflowImpl = implementWorkflow(workflow).finish((_outputs, input) =>
    fromPromise(() => ({ id: input.id })),
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

  it('plans coordinator and execution worker groups', async () => {
    const config = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [workflowImpl],
      workers: {
        coordinator: { threads: 2, concurrency: 3 },
        execution: { threads: 4 },
      },
    })
    const planner = defineWorkflowsPlanner(() => config)
    const plan = await planner({
      mode: 'development',
      name: 'workflows',
      logger,
    })

    expect(plan.options).toBeDefined()
    expect(plan.workers).toStrictEqual({
      coordinator: [{ role: 'coordinator' }, { role: 'coordinator' }],
      execution: [
        { role: 'execution', pool: 'execution' },
        { role: 'execution', pool: 'execution' },
        { role: 'execution', pool: 'execution' },
        { role: 'execution', pool: 'execution' },
      ],
    })
  })

  it('plans one worker group per named execution pool', async () => {
    const pooledWorkflow = defineWorkflow({
      name: 'neem.integration.pooled',
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    })
      .activity('handleUserRequest', {
        input: Schema.Struct({}),
        output: Schema.Struct({}),
      })
      .build()
    const pooledImpl = implementWorkflow(pooledWorkflow)
      .handleUserRequest(() => fromPromise(async () => ({})))
      .finish(() => fromPromise(() => ({})))
    const config = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [pooledImpl],
      workers: {
        execution: [
          {
            name: 'interactive',
            activityNames: ['handleUserRequest'],
            threads: 2,
            concurrency: 20,
            pollIntervalMs: 25,
            leaseMs: 6_000,
          },
          { name: 'batch', threads: 1, concurrency: 50 },
        ],
      },
    })
    const planner = defineWorkflowsPlanner(() => config)
    const plan = await planner({
      mode: 'development',
      name: 'workflows',
      logger,
    })

    expect(plan.workers).toStrictEqual({
      coordinator: [{ role: 'coordinator' }],
      execution: [
        { role: 'execution', pool: 'interactive' },
        { role: 'execution', pool: 'interactive' },
        { role: 'execution', pool: 'batch' },
      ],
    })

    const resolved = await resolveWorkflowsConfig(config)
    expect(resolved.workers.execution).toMatchObject([
      {
        name: 'interactive',
        activityNames: ['handleUserRequest'],
        concurrency: 20,
        pollIntervalMs: 25,
        leaseMs: 6_000,
      },
      {
        name: 'batch',
        activityNames: [],
        taskNames: [],
        concurrency: 50,
        pollIntervalMs: 250,
      },
    ])
  })

  it('rejects invalid execution pool lists', async () => {
    const reject = async (
      execution: readonly WorkflowsNamedExecutionWorkerPoolConfig[],
      message: string,
    ) => {
      const config = defineWorkflows({
        runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
        workflows: () => [workflowImpl],
        workers: { execution },
      })
      await expect(resolveWorkflowsConfig(config)).rejects.toThrow(message)
    }

    await reject([], 'must not be empty')
    await reject([{ name: '', activityNames: ['a'] }], 'requires a name')
    await reject(
      [
        { name: 'one', activityNames: ['a'] },
        { name: 'one', activityNames: ['b'] },
      ],
      'Duplicate workflows execution worker pool name [one]',
    )
    await reject(
      [{ name: 'one' }, { name: 'two' }],
      'only one catch-all pool is allowed',
    )
    await reject(
      [
        { name: 'one', activityNames: ['a'] },
        { name: 'two', activityNames: ['a'] },
      ],
      'Activity [a] is claimed by both workflows execution pools [one] and [two]',
    )
  })

  it('rejects unknown execution worker routing before starting the runtime', async () => {
    let runtimeCalls = 0
    const config = defineWorkflows({
      runtime: Effect.sync(() => {
        runtimeCalls += 1
        return createInMemoryWorkflowRuntime()
      }),
      workflows: () => [workflowImpl],
      workers: { execution: [{ name: 'primary' }] },
    })
    const worker = defineWorkflowsWorker(config)
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:execution:missing',
      data: { role: 'execution', pool: 'missing' },
      logger,
      definition: worker.definition,
      port: channel.port1,
    })

    try {
      await expect(runtime.start()).rejects.toThrow(
        'Unknown workflows execution worker pool [missing]',
      )
      expect(runtimeCalls).toBe(0)
    } finally {
      await runtime.stop()
      channel.port1.close()
      channel.port2.close()
    }
  })

  it('rejects named pools that leave a registered activity uncovered', async () => {
    const workflowWithActivities = defineWorkflow({
      name: 'neem.integration.pool-coverage',
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    })
      .activity('fast', { input: Schema.Struct({}), output: Schema.Struct({}) })
      .activity('slow', { input: Schema.Struct({}), output: Schema.Struct({}) })
      .build()
    const impl = implementWorkflow(workflowWithActivities)
      .fast(() => fromPromise(async () => ({})))
      .slow(() => fromPromise(async () => ({})))
      .finish(() => fromPromise(() => ({})))

    const uncovered = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [impl],
      workers: {
        execution: [{ name: 'interactive', activityNames: ['fast'] }],
      },
    })
    await expect(resolveWorkflowsConfig(uncovered)).rejects.toThrow(
      'Activities [slow] are not claimed by any workflows execution pool',
    )

    // a catch-all pool absorbs the rest — same pools plus catch-all resolves
    const covered = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [impl],
      workers: {
        execution: [
          { name: 'interactive', activityNames: ['fast'] },
          { name: 'batch' },
        ],
      },
    })
    await expect(resolveWorkflowsConfig(covered)).resolves.toBeDefined()

    // full explicit coverage needs no catch-all
    const explicit = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [impl],
      workers: {
        execution: [
          { name: 'interactive', activityNames: ['fast'] },
          { name: 'heavy', activityNames: ['slow'] },
        ],
      },
    })
    await expect(resolveWorkflowsConfig(explicit)).resolves.toBeDefined()

    // a selector naming an unknown activity is always a config bug: with a
    // catch-all it would silently reroute the real activity there
    const typo = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [impl],
      workers: {
        execution: [
          { name: 'interactive', activityNames: ['fastt'] },
          { name: 'batch' },
        ],
      },
    })
    await expect(resolveWorkflowsConfig(typo)).rejects.toThrow(
      'Activities [fastt] selected by workflows execution pools do not exist in the registered workflows',
    )
  })

  it('resolves catch-all selectors as the complement of named pools', async () => {
    const workflowWithActivities = defineWorkflow({
      name: 'neem.integration.pool-complement',
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    })
      .activity('fast', { input: Schema.Struct({}), output: Schema.Struct({}) })
      .activity('slow', { input: Schema.Struct({}), output: Schema.Struct({}) })
      .activity('bulk', { input: Schema.Struct({}), output: Schema.Struct({}) })
      .build()
    const impl = implementWorkflow(workflowWithActivities)
      .fast(() => fromPromise(async () => ({})))
      .slow(() => fromPromise(async () => ({})))
      .bulk(() => fromPromise(async () => ({})))
      .finish(() => fromPromise(() => ({})))

    const config = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [impl],
      workers: {
        execution: [
          { name: 'interactive', activityNames: ['fast'] },
          { name: 'batch' },
        ],
      },
    })
    const resolved = await resolveWorkflowsConfig(config)
    const [interactive, batch] = resolved.workers.execution

    expect(interactive!.activityNames).toStrictEqual(['fast'])
    expect(batch!.activityNames).toStrictEqual(['slow', 'bulk'])

    // A single catch-all resolves to every registered execution name.
    const soloConfig = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [impl],
      workers: { execution: [{ name: 'only' }] },
    })
    const solo = await resolveWorkflowsConfig(soloConfig)
    expect(solo.workers.execution[0]!.activityNames).toStrictEqual([
      'fast',
      'slow',
      'bulk',
    ])
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
    const parentImpl = implementWorkflow(parent)
      .child(child)
      .finish(() => fromPromise(() => ({})))

    await expect(
      resolveWorkflowsConfig(
        defineWorkflows({
          runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
          workflows: () => [parentImpl],
        }),
      ),
    ).rejects.toThrow(
      `Workflows [${child.name}] referenced by registered workflows have no registered implementation`,
    )
  })

  it('validates and resolves task selectors independently from activities', async () => {
    const task = defineTask({
      name: 'neem.integration.routed-task',
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    })
    const taskImpl = implementTask(task, {
      handler: () => fromPromise(async () => ({})),
    })
    const workflowWithTask = defineWorkflow({
      name: 'neem.integration.workflow-with-routed-task',
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    })
      .task('run', task)
      .build()
    const workflowWithTaskImpl = implementWorkflow(workflowWithTask)
      .run(task, { input: () => ({}) })
      .finish(() => fromPromise(() => ({})))
    const resolve = (
      execution: readonly WorkflowsNamedExecutionWorkerPoolConfig[],
    ) =>
      resolveWorkflowsConfig(
        defineWorkflows({
          runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
          workflows: () => [],
          tasks: () => [taskImpl],
          workers: { execution },
        }),
      )

    await expect(
      resolveWorkflowsConfig(
        defineWorkflows({
          runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
          workflows: () => [workflowWithTaskImpl],
        }),
      ),
    ).rejects.toThrow(
      `Tasks [${task.name}] referenced by registered workflows have no registered implementation`,
    )

    await expect(
      resolve([{ name: 'activity-only', activityNames: [] }]),
    ).rejects.toThrow(
      `Tasks [${task.name}] are not claimed by any workflows execution pool`,
    )
    await expect(
      resolve([
        { name: 'typo', taskNames: ['missing-task'] },
        { name: 'remaining' },
      ]),
    ).rejects.toThrow(
      'Tasks [missing-task] selected by workflows execution pools do not exist',
    )
    await expect(
      resolve([
        { name: 'one', taskNames: [task.name] },
        { name: 'two', taskNames: [task.name] },
      ]),
    ).rejects.toThrow(
      `Task [${task.name}] is claimed by both workflows execution pools [one] and [two]`,
    )

    const resolved = await resolve([
      { name: 'tasks', taskNames: [task.name] },
      { name: 'remaining' },
    ])
    expect(resolved.workers.execution).toMatchObject([
      { name: 'tasks', activityNames: [], taskNames: [task.name] },
      { name: 'remaining', activityNames: [], taskNames: [] },
    ])
  })

  it('accepts task implementations with typed dependencies', async () => {
    const prefix = Context.Reference<string>('test-prefix', {
      defaultValue: () => 'typed',
    })
    const task = defineTask({
      name: 'neem.integration.typed-task-dependencies',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
    const taskImpl = implementTask(task, {
      handler: (input) =>
        prefix.pipe(
          Effect.map((value) => ({
            text: `${value}:${input.text}`,
          })),
        ),
    })
    const config = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [],
      tasks: () => [taskImpl],
    })

    expect(await config.tasks?.()).toStrictEqual([taskImpl])
  })

  it('rejects invalid worker thread counts by role', async () => {
    const config = defineWorkflows({
      runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
      workflows: () => [workflowImpl],
      workers: {
        coordinator: { threads: 0 },
      },
    })
    const planner = defineWorkflowsPlanner(() => config)

    await expect(
      planner({
        mode: 'development',
        name: 'workflows',
        logger,
      }),
    ).rejects.toThrow('Invalid workflows worker thread count for coordinator')
  })

  it('creates and stops a worker runtime and disposes the adapter', async () => {
    const dispose = vi.fn()
    const config = defineWorkflows({
      runtime: Effect.sync(() => ({
        ...createInMemoryWorkflowRuntime(),
        dispose,
      })),
      workflows: () => [workflowImpl],
      workers: {
        coordinator: { pollIntervalMs: 1 },
      },
    })
    const worker = defineWorkflowsWorker(config)
    const channel = new MessageChannel()

    expect(isNeemRuntimeWorker(worker)).toBe(true)

    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:coordinator:0',
      data: { role: 'coordinator' },
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
    const worker = defineWorkflowsWorker(
      defineWorkflows({
        runtime: Effect.sync(acquire),
        workflows,
      }),
    )
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'concurrent-start',
      data: { role: 'coordinator' },
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
      const worker = defineWorkflowsWorker(
        defineWorkflows({
          runtime: Effect.sync(acquire),
          workflows: async () => {
            await definitions.promise
            return []
          },
        }),
      )
      const channel = new MessageChannel()
      const runtime = await worker.createRuntime({
        mode: 'development',
        name: 'stop-before-fiber',
        data: { role: 'coordinator' },
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
    const config = defineWorkflows({
      runtime: Effect.sync(() => runtimeAdapter),
      workflows: () => [],
      tasks: () => [taskImpl],
      workers: {
        execution: { pollIntervalMs: 1, leaseMs: 30 },
      },
    })
    const worker = defineWorkflowsWorker(config)
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:execution:shutdown',
      data: { role: 'execution' },
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
    const config = defineWorkflows({
      runtime: Effect.sync(() => brokenRuntime),
      workflows: () => [workflowImpl],
      workers: {
        coordinator: { pollIntervalMs: 1 },
      },
    })
    const worker = defineWorkflowsWorker(config)
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:coordinator:failure',
      data: { role: 'coordinator' },
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
      handler: (input) =>
        Effect.gen(function* () {
          const prefix = yield* pluginDependency
          return { text: `${prefix}:${input.text}:task` }
        }),
    })
    const fullWorkflowImpl = implementWorkflow(fullWorkflow)
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
    const config = defineWorkflows({
      runtime: Effect.sync(() => runtimeAdapter),
      workflows: () => [fullWorkflowImpl],
      tasks: () => [taskImpl],
      layer: services,
      workers: {
        coordinator: { pollIntervalMs: 1 },
        execution: { pollIntervalMs: 1 },
      },
    })
    const worker = defineWorkflowsWorker(config)
    const runtimes = await Promise.all(
      (['coordinator', 'execution'] as const).map(async (role) => {
        const channel = new MessageChannel()
        const runtime = await worker.createRuntime({
          mode: 'development',
          name: `workflows:${role}:0`,
          data: { role },
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
    const config = defineWorkflows({
      runtime: Effect.sync(() => runtimeAdapter),
      workflows: () => [workflowImpl],
      schedules: () => [schedule],
      workers: {
        coordinator: { pollIntervalMs: 1 },
      },
    })
    const worker = defineWorkflowsWorker(config)
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'workflows:coordinator:schedule',
      data: { role: 'coordinator' },
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

  it('starts and stops the lightweight host without instantiating implementations', async () => {
    expect(isNeemRuntimeHostFactory(workflowsHost)).toBe(true)
    let factoriesCalled = 0
    const host = await workflowsHost({
      mode: 'development',
      name: 'workflows',
      logger,
      threads: [],
      options: () =>
        defineWorkflows({
          runtime: Effect.sync(() => {
            factoriesCalled += 1
            return createInMemoryWorkflowRuntime()
          }),
          workflows: () => {
            factoriesCalled += 1
            return [workflowImpl]
          },
        }),
    })

    await host.start?.()
    await host.stop?.()

    expect(factoriesCalled).toBe(0)
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
