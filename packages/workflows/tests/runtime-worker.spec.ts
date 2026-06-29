import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  defineTask,
  implementTask,
  runTaskAttempt,
  runWithConcurrency,
  startTaskRun,
} from '../src/index.ts'
import { createInMemoryWorkflowRuntime } from './support/in-memory-runtime.ts'

describe('workflow worker concurrency', () => {
  const createTestContainer = () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    return new Container({ logger })
  }

  it('starts and completes a standalone task run without parent continuation', async () => {
    const task = defineTask({
      name: 'standalone.embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => ({ id: `embedding:${input.text}` }),
    })
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      input: { text: 'alpha' },
    })

    expect(run).toMatchObject({
      kind: 'task',
      name: task.name,
      taskName: task.name,
      input: { text: 'alpha' },
    })
    expect(runtime.inspect().taskCommands[0]?.payload).toMatchObject({
      taskName: task.name,
      runId: run.id,
      nodeName: '$task',
      input: { text: 'alpha' },
    })

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [task.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()
    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      tasks: [implementation],
      workerId: 'task-worker-1',
      container: createTestContainer(),
      claimed: claimed!,
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ id: 'embedding:alpha' })
    expect(completed?.nodes[0]?.status).toBe('completed')
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('runs workers without exceeding concurrency', async () => {
    const items = [1, 2, 3, 4, 5]
    let active = 0
    let maxActive = 0

    await runWithConcurrency(items, 2, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })

    expect(maxActive).toBe(2)
  })

  it('rejects invalid concurrency', async () => {
    await expect(
      runWithConcurrency([1], 0, async () => {}),
    ).rejects.toThrow('Concurrency must be a positive integer')
  })
})
