import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import { resolveWorkflowsRegistry } from '../src/neem/runtime.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runWorkflowWorker,
} from '../src/runtime/index.ts'
import { timeoutExpiredWorkflowRuns } from '../src/runtime/worker.ts'

const text = z.string()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('in-memory retention', () => {
  it('keeps a terminal parent whose child run carries its own root id', async () => {
    const { store } = createInMemoryWorkflowRuntime()
    const parent = await store.createRun({
      workflowName: 'review4.retention.parent',
      input: null,
    })
    // `rootRunId` is optional, so this child becomes the root of its own family
    // while still hanging off the parent.
    const child = await store.createRun({
      workflowName: 'review4.retention.child',
      input: null,
      parentRunId: parent.id,
      parentNodeName: 'sub',
    })
    expect(child.rootRunId).toBe(child.id)
    await store.completeRun({ runId: parent.id, output: null })

    const olderThan = Date.now() + 60_000
    expect(await store.pruneTerminalRuns({ olderThan })).toStrictEqual({
      deleted: 0,
    })
    expect(await store.loadRuns([parent.id, child.id])).toHaveLength(2)
    await expect(store.deleteRun(parent.id)).rejects.toThrow(
      'has non-terminal runs',
    )

    await store.completeRun({ runId: child.id, output: null })
    expect(await store.pruneTerminalRuns({ olderThan })).toStrictEqual({
      deleted: 1,
    })
    expect(await store.loadRuns([parent.id, child.id])).toHaveLength(0)
  })
})

describe('duplicate implementations in registry validation', () => {
  const io = { input: z.object({}), output: z.object({}) }
  const data = { role: 'execution' } as const
  const workflow = defineWorkflow({
    name: 'review4.dup.workflow',
    ...io,
  }).build()
  const implement = () =>
    implementWorkflow(workflow, { pool: 'test' }).finish(() => ({}))
  const task = defineTask({ name: 'review4.dup.task', ...io })
  const implementDuplicateTask = () =>
    implementTask(task, { pool: 'test', handler: () => ({}) })

  it('rejects two implementations of one workflow', async () => {
    await expect(
      resolveWorkflowsRegistry(
        { workflows: () => [implement(), implement()] },
        data,
      ),
    ).rejects.toThrow(
      `Implementations [workflow:${workflow.name}] are registered more than once`,
    )
  })

  it('rejects two implementations of one task', async () => {
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [implement()],
          tasks: () => [implementDuplicateTask(), implementDuplicateTask()],
        },
        data,
      ),
    ).rejects.toThrow(
      `Implementations [task:${task.name}] are registered more than once`,
    )
  })

  it('still accepts one implementation listed more than once', async () => {
    const workflowImplementation = implement()
    const taskImplementation = implementDuplicateTask()
    const resolved = await resolveWorkflowsRegistry(
      {
        workflows: () => [workflowImplementation, workflowImplementation],
        tasks: () => [taskImplementation, taskImplementation],
      },
      data,
    )
    expect(resolved.workflows).toStrictEqual([workflowImplementation])
    expect(resolved.tasks).toStrictEqual([taskImplementation])
  })
})

describe('in-memory schedule fire', () => {
  it('keeps a disable that lands while the fire creates its run', async () => {
    const workflow = defineWorkflow({
      name: 'review4.schedule.workflow',
      input: text,
      output: text,
    }).build()
    const schedule = defineSchedule({
      name: 'review4.schedule',
      runnable: workflow,
      input: 'x',
      every: '10ms',
      immediately: true,
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const scheduler = runtime.scheduler!
    await scheduler.reconcile([schedule])
    const [before] = await scheduler.list()
    const now = before!.nextRunAt + 1_000

    // The fire is suspended on its run creation when the disable lands.
    const firing = scheduler.fireDue({ now })
    const disabled = await scheduler.setEnabled(schedule.name, false)
    expect(disabled.enabled).toBe(false)
    await expect(firing).resolves.toStrictEqual({ fired: 1 })

    const [after] = await scheduler.list()
    expect(after).toMatchObject({
      enabled: false,
      lastSlotAt: before!.nextRunAt,
    })
    expect(after!.nextRunAt).toBeGreaterThan(now)
    await expect(
      scheduler.fireDue({ now: after!.nextRunAt + 1_000 }),
    ).resolves.toStrictEqual({ fired: 0 })
    const { runs } = await client.list({ tags: { schedule: schedule.name } })
    expect(runs).toHaveLength(1)
  })

  it('does not restore a schedule a reconcile removed during the fire', async () => {
    const workflow = defineWorkflow({
      name: 'review4.schedule.removed.workflow',
      input: text,
      output: text,
    }).build()
    const schedule = defineSchedule({
      name: 'review4.schedule.removed',
      runnable: workflow,
      input: 'x',
      every: '10ms',
      immediately: true,
    })
    const runtime = createInMemoryWorkflowRuntime()
    const scheduler = runtime.scheduler!
    await scheduler.reconcile([schedule])
    const [before] = await scheduler.list()

    const firing = scheduler.fireDue({ now: before!.nextRunAt + 1_000 })
    await scheduler.reconcile([])
    await firing

    expect(await scheduler.list()).toStrictEqual([])
  })
})

describe('interrupted run timeout', () => {
  function setup() {
    const leaf = defineWorkflow({
      name: 'review4.timeout.leaf',
      input: text,
      output: text,
    })
      .activity('step', { input: text, output: text })
      .build()
    const leafImplementation = implementWorkflow(leaf, { pool: 'test' })
      .step(async (input) => input)
      .finish(({ step }) => step)
    const middle = defineWorkflow({
      name: 'review4.timeout.middle',
      input: text,
      output: text,
      timeout: '20ms',
    })
      .workflow('sub', leaf)
      .build()
    const middleImplementation = implementWorkflow(middle, { pool: 'test' })
      .sub(leaf)
      .finish(({ sub }) => sub)
    const parent = defineWorkflow({
      name: 'review4.timeout.parent',
      input: text,
      output: text,
    })
      .workflow('sub', middle)
      .build()
    const parentImplementation = implementWorkflow(parent, { pool: 'test' })
      .sub(middle)
      .finish(({ sub }) => sub)

    const runtime = createInMemoryWorkflowRuntime()
    const workflows = [
      parentImplementation,
      middleImplementation,
      leafImplementation,
    ]
    const workers = {
      ...runtime,
      workflows,
      workerId: 'review4',
      reaping: false,
      runTimeouts: false,
    } as const
    const runOf = (name: string) =>
      runtime.inspect().runs.find((run) => run.workflowName === name)!
    return { runtime, workflows, workers, parent, middle, leaf, runOf }
  }

  it('leaves the run for the next sweep when failing it is rejected', async () => {
    const { runtime, workflows, workers, parent, middle, leaf, runOf } = setup()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(parent, 'hi')
    // No execution worker ever runs, so the leaf sits on its activity.
    await runWorkflowWorker(workers)
    await wait(30)

    await expect(
      timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows,
        store: {
          ...runtime.store,
          failRun: async () => {
            throw new Error('injected failRun failure')
          },
        },
      }),
    ).rejects.toThrow('injected failRun failure')

    // The queued continuation must find nothing to cancel.
    await runWorkflowWorker(workers)
    expect(runOf(middle.name).status).toBe('waiting')
    expect(runOf(leaf.name).status).toBe('running')
    expect((await client.get(run.id))!.run.status).toBe('waiting')

    expect(
      await timeoutExpiredWorkflowRuns({ ...runtime, workflows }),
    ).toStrictEqual({ timedOut: 1 })
    await runWorkflowWorker(workers)

    const timedOut = runOf(middle.name)
    expect(timedOut.status).toBe('failed')
    expect(timedOut.error?.message).toContain('timed out after [20ms]')
    expect(runOf(leaf.name).status).toBe('cancelled')
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('failed')
    expect(snapshot.run.error?.message).toContain('timed out after [20ms]')
  })

  it('finishes the cancellation and the parent wake after a crash right after failing the run', async () => {
    const { runtime, workflows, workers, parent, middle, leaf, runOf } = setup()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(parent, 'hi')
    await runWorkflowWorker(workers)
    await wait(30)

    await expect(
      timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows,
        store: {
          ...runtime.store,
          failRun: async (params) => {
            await runtime.store.failRun(params)
            throw new Error('injected crash after failRun')
          },
        },
      }),
    ).rejects.toThrow('injected crash after failRun')

    expect(runOf(middle.name).status).toBe('failed')
    expect(runOf(middle.name).error?.message).toContain(
      'timed out after [20ms]',
    )
    expect(runOf(leaf.name).status).toBe('running')
    // The terminal run is out of every later sweep's reach.
    expect(
      await timeoutExpiredWorkflowRuns({ ...runtime, workflows }),
    ).toStrictEqual({ timedOut: 0 })

    await runWorkflowWorker(workers)
    await runWorkflowWorker(workers)

    expect(runOf(middle.name).status).toBe('failed')
    expect(runOf(leaf.name).status).toBe('cancelled')
    expect(
      runtime
        .inspect()
        .nodes.filter(({ runId }) => runId === runOf(middle.name).id)
        .map(({ status }) => status),
    ).toStrictEqual(['cancelled'])
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('failed')
    expect(snapshot.run.error?.message).toContain('timed out after [20ms]')
  })
})
