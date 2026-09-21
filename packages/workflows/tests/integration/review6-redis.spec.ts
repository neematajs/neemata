import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  type WorkflowStore,
} from '../../src/runtime/index.ts'
import { timeoutExpiredWorkflowRuns } from '../../src/runtime/worker.ts'
import { matchingKeys, wait } from './helpers.ts'

type Target = {
  readonly name: string
  readonly url: string | undefined
  createClient(): Redis | Valkey
}

const targets: readonly Target[] = [
  {
    name: 'Redis',
    url: process.env.REDIS_URL,
    createClient: () => new Redis(process.env.REDIS_URL!),
  },
  {
    name: 'Valkey',
    url: process.env.VALKEY_URL,
    createClient: () => new Valkey(process.env.VALKEY_URL!),
  },
]

const text = z.string()

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

for (const target of targets) {
  describe.skipIf(!target.url)(
    `Redis sixth review regressions against ${target.name}`,
    () => {
      const clients: (Redis | Valkey)[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        await Promise.allSettled(
          runtimes.splice(0).map(async (runtime, index) => {
            await runtime.dispose?.()
            const client = clients[index]!
            const keys = await matchingKeys(client, `${runtime.keyPrefix}*`)
            for (let offset = 0; offset < keys.length; offset += 100) {
              await client.del(...keys.slice(offset, offset + 100))
            }
          }),
        )
        await Promise.allSettled(
          clients.splice(0).map(async (client) => await client.quit()),
        )
      })

      function createRuntime() {
        const client = target.createClient()
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix: `nmtjs:test:review6-redis:${randomUUID()}:`,
        })
        clients.push(client)
        runtimes.push(runtime)
        return runtime
      }

      it('completes a reopened child task run from its completed attempt', async () => {
        let taskRan = 0
        const task = defineTask({
          name: `review6-task-${randomUUID()}`,
          input: text,
          output: text,
        })
        const taskImplementation = implementTask(task, {
          pool: 'test',
          handler: async (input) => {
            taskRan += 1
            return `${input}-task`
          },
        })
        const workflow = defineWorkflow({
          name: `review6-retry-${randomUUID()}`,
          input: text,
          output: text,
          timeout: '100ms',
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

        const runtime = createRuntime()
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

        // The attempt and its child settle; the task run's node and run
        // completion are still pending when the parent times out.
        const paused = gate()
        const gated: WorkflowStore = {
          ...runtime.store,
          completeNode: async (params) => {
            await paused.pass()
            return runtime.store.completeNode(params)
          },
        }
        const execution = runExecutionWorker({ ...workers, store: gated })
        await paused.reached
        await wait(150)
        expect(
          await timeoutExpiredWorkflowRuns({
            ...runtime,
            workflows: [implementation],
          }),
        ).toStrictEqual({ timedOut: 1 })
        // The worker acknowledges before the retry: nothing stale writes after.
        paused.release()
        await execution
        await runWorkflowWorker(workers)

        const timedOut = (await client.get(run.id))!
        expect(timedOut.run.status).toBe('failed')
        const taskRunId = timedOut.children.find(
          (child) => child.nodeName === 'first',
        )!.childRunId!
        expect((await client.get(taskRunId))!.run.status).toBe('cancelled')

        await client.retry(run.id)
        for (let pass = 0; pass < 3; pass += 1) {
          await runWorkflowWorker(workers)
          await runExecutionWorker(workers)
        }

        const taskRun = (await client.get(taskRunId))!
        expect(taskRun.run.status).toBe('completed')
        expect(taskRun.run.output).toBe('hi-task')
        expect(taskRun.attempts.map((attempt) => attempt.status)).toStrictEqual(
          ['completed'],
        )
        const retried = (await client.get(run.id))!
        expect(retried.run.status).toBe('completed')
        expect(retried.run.output).toBe('hi-task-second')
        expect(taskRan).toBe(1)
      })

      it('leaves a lease-held child workflow to its own continuation, which cancels what the pass started', async () => {
        let leafRan = 0
        const leaf = defineWorkflow({
          name: `review6-leaf-${randomUUID()}`,
          input: text,
          output: text,
        })
          .activity('step', { input: text, output: text })
          .build()
        const leafImplementation = implementWorkflow(leaf, { pool: 'test' })
          .step(async (input) => {
            leafRan += 1
            return input
          })
          .finish(({ step }) => step)
        const middle = defineWorkflow({
          name: `review6-middle-${randomUUID()}`,
          input: text,
          output: text,
        })
          .workflow('sub', leaf)
          .build()
        const middleImplementation = implementWorkflow(middle, { pool: 'test' })
          .sub(leaf)
          .finish(({ sub }) => sub)
        const parent = defineWorkflow({
          name: `review6-parent-${randomUUID()}`,
          input: text,
          output: text,
        })
          .workflow('sub', middle)
          .build()
        const parentImplementation = implementWorkflow(parent, { pool: 'test' })
          .sub(middle)
          .finish(({ sub }) => sub)

        const runtime = createRuntime()
        const client = createWorkflowRuntimeClient(runtime)
        const base = {
          ...runtime,
          workerId: 'review6',
          reaping: false,
          runTimeouts: false,
        } as const
        const all = [
          parentImplementation,
          middleImplementation,
          leafImplementation,
        ]
        const statusOf = async (rootRunId: string, name: string) =>
          (await client.getFamily(rootRunId)).find(
            (entry) => entry.run.workflowName === name,
          )?.run.status

        const run = await client.start(parent, 'hi')
        await runWorkflowWorker({ ...base, workflows: [parentImplementation] })

        // The middle pass is suspended on the write that creates the leaf,
        // past every cancellation check it makes itself.
        const paused = gate()
        const gated: WorkflowStore = {
          ...runtime.store,
          ensureChildRun: async (params) => {
            await paused.pass()
            return runtime.store.ensureChildRun(params)
          },
        }
        const middlePass = runWorkflowWorker({
          ...base,
          store: gated,
          workflows: [middleImplementation],
        })
        await paused.reached

        await client.cancel(run.id)
        await runWorkflowWorker({ ...base, workflows: [parentImplementation] })
        expect((await client.get(run.id))!.run.status).toBe('cancelled')
        expect(await statusOf(run.id, middle.name)).toBe('cancelling')

        paused.release()
        await middlePass
        for (let pass = 0; pass < 3; pass += 1) {
          await runWorkflowWorker({ ...base, workflows: all })
          await runExecutionWorker({ ...base, workflows: all, tasks: [] })
        }

        expect(await statusOf(run.id, leaf.name)).toBe('cancelled')
        expect(await statusOf(run.id, middle.name)).toBe('cancelled')
        expect((await client.get(run.id))!.run.status).toBe('cancelled')
        expect(leafRan).toBe(0)
      })
    },
  )
}
