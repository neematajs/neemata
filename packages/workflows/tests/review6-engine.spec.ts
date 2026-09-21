import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  type WorkflowStore,
} from '../src/runtime/index.ts'
import { timeoutExpiredWorkflowRuns } from '../src/runtime/worker.ts'

const text = z.string()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Suspends the first matching call so the test can interleave other actors. */
function gate() {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let used = false
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    async pass() {
      if (used) return
      used = true
      reached.resolve()
      await released.promise
    },
  }
}

describe('manual retry over a child task whose attempt settled before its run', () => {
  /**
   * The task worker settles its attempt, then is suspended on `gatedWrite`
   * while the parent times out. It resumes and acknowledges before the retry,
   * so nothing stale writes after the reopen.
   */
  async function timeOutParentMidSettlement(options: {
    readonly gatedWrite: 'completeNode' | 'completeRun' | 'failNodeChild'
    readonly handler: (input: string, ran: number) => string
  }) {
    let taskRan = 0
    const task = defineTask({
      name: `review6.retry.task.${options.gatedWrite}`,
      input: text,
      output: text,
    })
    const taskImplementation = implementTask(task, {
      pool: 'test',
      handler: async (input) => {
        taskRan += 1
        return options.handler(input, taskRan)
      },
    })
    const workflow = defineWorkflow({
      name: `review6.retry.workflow.${options.gatedWrite}`,
      input: text,
      output: text,
      timeout: '20ms',
    })
      .task('first', task)
      .activity('second', { input: text, output: text })
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .first(task)
      .second(async (input) => `${input}-second`, {
        input: ({ first }) => first,
      })
      .finish(({ second }) => second)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [taskImplementation],
      workerId: 'review6',
      reaping: false,
      runTimeouts: false,
    } as const
    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)

    const paused = gate()
    const gated: WorkflowStore = {
      ...runtime.store,
      [options.gatedWrite]: async (params: never) => {
        await paused.pass()
        return runtime.store[options.gatedWrite](params)
      },
    }
    const execution = runExecutionWorker({ ...workers, store: gated })
    await paused.reached
    await wait(30)
    expect(
      await timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows: [implementation],
      }),
    ).toStrictEqual({ timedOut: 1 })
    paused.release()
    await execution
    await runWorkflowWorker(workers)

    const timedOut = (await client.get(run.id))!
    expect(timedOut.run.status).toBe('failed')
    const taskRunId = timedOut.children.find(
      (child) => child.nodeName === 'first',
    )!.childRunId!
    expect((await client.get(taskRunId))!.run.status).toBe('cancelled')
    expect(runtime.inspect().taskCommands).toHaveLength(0)

    await client.retry(run.id)
    for (let pass = 0; pass < 3; pass += 1) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }
    return {
      parent: (await client.get(run.id))!,
      taskRun: (await client.get(taskRunId))!,
      taskRan: () => taskRan,
    }
  }

  it.each(['completeNode', 'completeRun'] as const)(
    'completes the task run from the completed attempt when the timeout lands before its %s',
    async (gatedWrite) => {
      const result = await timeOutParentMidSettlement({
        gatedWrite,
        handler: (input) => `${input}-task`,
      })

      expect(result.taskRun.run.status).toBe('completed')
      expect(result.taskRun.run.output).toBe('hi-task')
      expect(
        result.taskRun.attempts.map((attempt) => attempt.status),
      ).toStrictEqual(['completed'])
      expect(result.parent.run.status).toBe('completed')
      expect(result.parent.run.output).toBe('hi-task-second')
      expect(result.taskRan()).toBe(1)
    },
  )

  it('still reruns a task whose preserved attempt failed', async () => {
    const result = await timeOutParentMidSettlement({
      gatedWrite: 'failNodeChild',
      handler: (input, ran) => {
        if (ran === 1) throw new Error('first try fails')
        return `${input}-task`
      },
    })

    expect(
      result.taskRun.attempts.map((attempt) => attempt.status),
    ).toStrictEqual(['failed', 'completed'])
    expect(result.parent.run.status).toBe('completed')
    expect(result.parent.run.output).toBe('hi-task-second')
    expect(result.taskRan()).toBe(2)
  })
})
