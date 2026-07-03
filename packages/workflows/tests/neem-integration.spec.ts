import { MessageChannel } from 'node:worker_threads'

import { createLogger } from '@nmtjs/core'
import {
  isNeemRuntimeDeclaration,
  isNeemRuntimeHostFactory,
  isNeemRuntimeWorker,
} from '@nmtjs/neem'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import {
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
} from '../src/neem/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  type WorkflowRuntimeAdapter,
} from '../src/runtime/index.ts'

describe('workflows Neem integration', () => {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')

  const workflow = defineWorkflow({
    name: 'neem.integration.empty',
    input: t.object({ id: t.string() }),
    output: t.object({ id: t.string() }),
  }).build()
  const workflowImpl = implementWorkflow(workflow).finish(
    (_ctx, _outputs, input) => ({ id: input.id }),
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

  it('plans coordinator, activity, and task worker groups', async () => {
    const config = defineWorkflows({
      runtime: () => createInMemoryWorkflowRuntime(),
      workflows: () => [workflowImpl],
      workers: {
        coordinator: { threads: 2, concurrency: 3 },
        activity: { threads: 1 },
        task: { threads: 4 },
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
      activity: [{ role: 'activity' }],
      task: [],
    })
  })

  it('rejects invalid worker thread counts by role', async () => {
    const config = defineWorkflows({
      runtime: () => createInMemoryWorkflowRuntime(),
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
      runtime: () => ({
        ...createInMemoryWorkflowRuntime(),
        dispose,
      }),
      workflows: () => [workflowImpl],
      workers: {
        coordinator: { pollIntervalMs: 1, maxIdleClaims: 1 },
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
    expect(dispose).toHaveBeenCalledOnce()
    channel.port1.close()
    channel.port2.close()
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
      runtime: () => brokenRuntime,
      workflows: () => [workflowImpl],
      workers: {
        coordinator: { pollIntervalMs: 1, maxIdleClaims: 1 },
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
    await expect(runtime.stop()).rejects.toThrow('coordinator claim failed')
    expect(errorSpy).toHaveBeenCalledWith(
      { err: failure },
      'Neem workflows worker loop failed',
    )
    channel.port1.close()
    channel.port2.close()
    errorSpy.mockRestore()
  })

  it('runs coordinator, activity, and task role loops end-to-end', async () => {
    const task = defineTask({
      name: 'neem.integration.task',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
    const fullWorkflow = defineWorkflow({
      name: 'neem.integration.full',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('activity', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .task('task', task)
      .build()
    const taskImpl = implementTask(task, {
      handler: async (_ctx, input) => ({ text: `${input.text}:task` }),
    })
    const fullWorkflowImpl = implementWorkflow(fullWorkflow)
      .activity(async (_ctx, input) => ({ text: `${input.text}:activity` }), {
        input: (_ctx, _outputs, input) => ({ text: input.text }),
      })
      .task(task, {
        input: (_ctx, { activity }) => ({ text: activity.text }),
      })
      .finish((_ctx, { task }) => ({ text: task.text }))
    const runtimeAdapter = createInMemoryWorkflowRuntime()
    const config = defineWorkflows({
      runtime: () => runtimeAdapter,
      workflows: () => [fullWorkflowImpl],
      tasks: () => [taskImpl],
      workers: {
        coordinator: { pollIntervalMs: 1, maxIdleClaims: 1 },
        activity: { pollIntervalMs: 1, maxIdleClaims: 1 },
        task: { pollIntervalMs: 1, maxIdleClaims: 1 },
      },
    })
    const worker = defineWorkflowsWorker(config)
    const runtimes = await Promise.all(
      (['coordinator', 'activity', 'task'] as const).map(async (role) => {
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
      expect(snapshot.run.output).toStrictEqual({ text: 'alpha:activity:task' })
    } finally {
      await Promise.allSettled(
        runtimes.map(({ runtime }) => Promise.resolve(runtime.stop())),
      )
      for (const { channel } of runtimes) {
        channel.port1.close()
        channel.port2.close()
      }
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
          runtime: () => {
            factoriesCalled += 1
            return createInMemoryWorkflowRuntime()
          },
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
