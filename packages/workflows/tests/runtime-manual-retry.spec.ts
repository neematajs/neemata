import { PGlite } from '@electric-sql/pglite'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
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
} from '../src/runtime/index.ts'
import {
  reapDeadWorkflowCommands,
  timeoutExpiredWorkflowRuns,
} from '../src/runtime/worker.ts'

for (const adapter of ['memory', 'postgres'] as const) {
  describe(`${adapter} manual retry`, () => {
    let database: PGlite | undefined
    afterEach(async () => {
      vi.useRealTimers()
      await database?.close()
    })
    async function setup(maxDeliveries = 20) {
      const container = new Container({
        logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
      })
      if (adapter === 'memory')
        return {
          ...createInMemoryWorkflowRuntime({ maxDeliveries }),
          container,
        }
      database = new PGlite()
      const connection = createPostgresWorkflowConnection(database)
      await installPostgresWorkflowSchemaForTesting(connection)
      return {
        ...createPostgresWorkflowRuntime({ connection, maxDeliveries }),
        container,
      }
    }

    it('retries only failed parallel members and preserves attempts, inputs and completed output', async () => {
      const runtime = await setup()
      let fail = true
      let mapped = 0
      const calls = { good: 0, bad: 0 }
      const workflow = defineWorkflow({
        name: 'parallel-retry',
        input: t.object({ value: t.number() }),
      })
        .parallel('members', (h) => ({
          good: h.activity({ input: t.unknown(), output: t.unknown() }),
          bad: h.activity({
            input: t.object({ value: t.number() }),
            output: t.object({ value: t.number() }),
          }),
        }))
        .build()
      const impl = implementWorkflow(workflow)
        .members(({ activity }) => ({
          good: activity(async () => {
            calls.good++
            return 'saved'
          }),
          bad: activity(
            async (_ctx, input) => {
              calls.bad++
              if (fail) throw new Error('temporary')
              return input
            },
            {
              input: () => {
                mapped++
                return { value: 42 }
              },
              idempotency: () => ['member-key'],
            },
          ),
        }))
        .finish((_ctx, outputs) => outputs.members)
      const client = createWorkflowRuntimeClient({
        ...runtime,
        definitions: [workflow],
      })
      const run = await client.start(
        workflow,
        { value: 1 },
        { tags: { source: 'test' }, idempotencyKey: ['root-key'] },
      )
      const coordinate = () =>
        runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
          reaping: false,
          runTimeouts: false,
        })
      const execute = () =>
        runExecutionWorker({
          ...runtime,
          workflows: [impl],
          tasks: [],
          workerId: 'executor',
          reaping: false,
        })
      await coordinate()
      await execute()
      await coordinate()
      const before = (await client.get(run.id))!
      expect(before.run.status).toBe('failed')
      expect(calls).toEqual({ good: 1, bad: 1 })
      fail = false
      const retry = await client.retry(run.id, {
        expectedVersion: before.run.version,
      })
      expect(retry).toMatchObject({
        id: run.id,
        input: { value: 1 },
        tags: { source: 'test' },
        idempotencyKey: ['root-key'],
      })
      expect(retry.activeSince.getTime()).toBeGreaterThanOrEqual(
        before.run.activeSince.getTime(),
      )
      expect(retry.createdAt).toEqual(before.run.createdAt)
      await expect(
        client.retry(run.id, { expectedVersion: before.run.version }),
      ).rejects.toThrow()
      await coordinate()
      await execute()
      await coordinate()
      const after = (await client.get(run.id))!
      expect(after.run.status).toBe('completed')
      expect(after.run.output).toEqual({ good: 'saved', bad: { value: 42 } })
      expect(calls).toEqual({ good: 1, bad: 2 })
      expect(mapped).toBe(1)
      for (const attempt of before.attempts)
        expect(after.attempts.find((a) => a.id === attempt.id)).toEqual(attempt)
      expect(after.attempts).toHaveLength(3)
      expect(
        after.attempts.find((a) => a.attemptNumber === 2)?.idempotencyKey,
      ).toEqual(['member-key'])
      const restarted = await client.restart(run.id)
      expect(restarted.id).not.toBe(run.id)
      expect((await client.get(restarted.id))?.nodes).toEqual([])
    })

    it('settles bounded maps and retries their failed task runs within the same concurrency limit', async () => {
      const runtime = await setup()
      let fail = true
      const calls: number[] = []
      const task = defineTask({
        name: 'map-task',
        input: t.number(),
        output: t.number(),
      })
      const taskImpl = implementTask(task, {
        handler: async (_ctx, item) => {
          calls.push(item)
          if (fail && item !== 1) throw new Error('temporary')
          return item * 2
        },
      })
      const workflow = defineWorkflow({
        name: 'map-retry',
        input: t.array(t.number()),
      })
        .mapTask('items', task, { item: t.number(), concurrency: 1 })
        .build()
      const impl = implementWorkflow(workflow)
        .items(task, {
          items: (_ctx, _outputs, input) => input,
          input: (_ctx, _outputs, item) => item,
        })
        .finish((_ctx, outputs) => outputs.items)
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, [0, 1, 2, 3])
      const coordinate = () =>
        runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
          reaping: false,
          runTimeouts: false,
        })
      const execute = () =>
        runExecutionWorker({
          ...runtime,
          workflows: [impl],
          tasks: [taskImpl],
          workerId: 'executor',
          reaping: false,
        })
      for (let index = 0; index < 4; index++) {
        await coordinate()
        await execute()
        expect(calls).toHaveLength(index + 1)
      }
      await coordinate()
      const before = (await client.get(run.id))!
      expect(before.run.status).toBe('failed')
      const childIds = before.children.map((child) => child.childRunId)
      fail = false
      await client.retry(run.id)
      for (let index = 0; index < 3; index++) {
        await coordinate()
        await execute()
        expect(calls).toHaveLength(5 + index)
      }
      await coordinate()
      const after = (await client.get(run.id))!
      expect(after.run.status).toBe('completed')
      expect(after.children.map((child) => child.childRunId)).toEqual(childIds)
      expect(calls).toEqual([0, 1, 2, 3, 0, 2, 3])
      expect(after.run.output).toEqual({
        items: childIds.map((runId, index) => ({
          item: index,
          index,
          runId,
          output: index * 2,
        })),
      })
    })

    it('replenishes root task retry budgets while rejecting concurrent retries', async () => {
      const runtime = await setup()
      let calls = 0
      const task = defineTask({
        name: 'root-task',
        input: t.number(),
        output: t.number(),
        retry: { attempts: 3 },
      })
      const impl = implementTask(task, {
        handler: async () => {
          calls++
          throw new Error('failed')
        },
      })
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(task, 7)
      const execute = () =>
        runExecutionWorker({
          ...runtime,
          workflows: [],
          tasks: [impl],
          workerId: 'executor',
          reaping: false,
        })
      await execute()
      const before = (await client.get(run.id))!
      const results = await Promise.allSettled([
        client.retry(run.id, { expectedVersion: before.run.version }),
        client.retry(run.id, { expectedVersion: before.run.version }),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      await execute()
      expect(calls).toBe(6)
      expect(
        (await client.get(run.id))?.attempts.map((a) => a.attemptNumber),
      ).toEqual([1, 2, 3, 4, 5, 6])
      await expect(
        client.retry(run.id, { expectedVersion: before.run.version }),
      ).rejects.toThrow('Stale retry version')
    })

    for (const kind of ['task', 'activity'] as const) {
      it(`resets ${kind} budgets and backoff on repeated manual retries`, async () => {
        const runtime = await setup()
        const retry = {
          attempts: 3,
          delay: '1s',
          backoff: 'exponential',
        } as const
        let calls = 0
        let succeed = false
        const handler = async () => {
          calls++
          if (!succeed) throw new Error('temporary')
          return 7
        }
        const task = defineTask({
          name: 'budget-task',
          input: t.number(),
          output: t.number(),
          retry,
        })
        const taskImpl = implementTask(task, { handler })
        const workflow = defineWorkflow({
          name: 'budget-workflow',
          input: t.number(),
        })
          .activity('review', { input: t.number(), output: t.number(), retry })
          .build()
        const workflowImpl = implementWorkflow(workflow)
          .review(handler)
          .finish((_ctx, outputs) => outputs.review)
        const delays: number[] = []
        const dispatch = kind === 'task' ? 'dispatchTask' : 'dispatchActivity'
        // Inspect scheduling without waiting for timers, including transaction-scoped executors.
        const interceptBackoff = (executor: typeof runtime.attemptExecutor) => {
          const original = executor[dispatch].bind(executor)
          vi.spyOn(executor, dispatch).mockImplementation(
            async (command, options) => {
              if (options?.runAt)
                delays.push(
                  Math.round((options.runAt.getTime() - Date.now()) / 1000),
                )
              return original(command as never)
            },
          )
        }
        interceptBackoff(runtime.attemptExecutor)
        const atomicCompletion =
          'atomicCompletion' in runtime ? runtime.atomicCompletion : undefined
        if (atomicCompletion) {
          const original = atomicCompletion.run.bind(atomicCompletion)
          vi.spyOn(atomicCompletion, 'run').mockImplementation((handler) =>
            original(async (scoped) => {
              interceptBackoff(scoped.attemptExecutor)
              return handler(scoped)
            }),
          )
        }
        const client = createWorkflowRuntimeClient(runtime)
        const run =
          kind === 'task'
            ? await client.start(task, 7)
            : await client.start(workflow, 7)
        const execute = async () => {
          if (kind === 'activity')
            await runWorkflowWorker({
              ...runtime,
              workflows: [workflowImpl],
              workerId: 'coordinator',
              reaping: false,
              runTimeouts: false,
            })
          await runExecutionWorker({
            ...runtime,
            workflows: [workflowImpl],
            tasks: [taskImpl],
            workerId: 'executor',
            reaping: false,
          })
          if (kind === 'activity')
            await runWorkflowWorker({
              ...runtime,
              workflows: [workflowImpl],
              workerId: 'coordinator',
              reaping: false,
              runTimeouts: false,
            })
        }
        await execute()
        const before = (await client.get(run.id))!
        expect(before.run.status).toBe('failed')
        expect(calls).toBe(3)
        await client.retry(run.id)
        await execute()
        const after = (await client.get(run.id))!
        expect(after.run.status).toBe('failed')
        expect(calls).toBe(6)
        expect(delays).toEqual([1, 2, 1, 2])
        expect(after.attempts.map((attempt) => attempt.attemptNumber)).toEqual([
          1, 2, 3, 4, 5, 6,
        ])
        expect(
          after.attempts.map((attempt) => attempt.retryAttemptNumber),
        ).toEqual([1, 2, 3, 1, 2, 3])
        for (const attempt of before.attempts)
          expect(after.attempts.find((item) => item.id === attempt.id)).toEqual(
            attempt,
          )
        succeed = true
        await client.retry(run.id)
        await execute()
        const completed = (await client.get(run.id))!
        expect(completed.run.status).toBe('completed')
        expect(calls).toBe(7)
        expect(completed.attempts.at(-1)).toMatchObject({
          attemptNumber: 7,
          retryAttemptNumber: 1,
        })
        expect(delays).toEqual([1, 2, 1, 2])
      })
    }

    it('retries finish failures without repeating successful activities and resets timeout age', async () => {
      const runtime = await setup()
      let fail = true
      let calls = 0
      const workflow = defineWorkflow({
        name: 'finish-retry',
        input: t.object({}),
        timeout: '1h',
      })
        .activity('saved', { input: t.object({}), output: t.number() })
        .build()
      const impl = implementWorkflow(workflow)
        .saved(async () => {
          calls++
          return 42
        })
        .finish((_ctx, outputs) => {
          if (fail) throw new Error('finish failed')
          return outputs.saved
        })
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, {})
      const coordinate = () =>
        runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
          reaping: false,
          runTimeouts: false,
        })
      await coordinate()
      await runExecutionWorker({
        ...runtime,
        workflows: [impl],
        tasks: [],
        workerId: 'executor',
        reaping: false,
      })
      await coordinate()
      expect((await client.get(run.id))?.run.status).toBe('failed')
      fail = false
      const retry = await client.retry(run.id)
      expect(
        await timeoutExpiredWorkflowRuns({
          ...runtime,
          workflows: [impl],
          now: retry.activeSince,
        }),
      ).toEqual({ timedOut: 0 })
      await coordinate()
      expect((await client.get(run.id))?.run.output).toBe(42)
      expect(calls).toBe(1)
      await expect(client.retry(run.id)).rejects.toThrow('not failed')
    })

    it('rejects uniqueness collisions without joining another run or mutating failed state', async () => {
      const runtime = await setup()
      const workflow = defineWorkflow({
        name: 'unique-retry',
        input: t.object({}),
      }).build()
      const client = createWorkflowRuntimeClient(runtime)
      const unique = {
        key: ['unique-retry'],
        scope: 'active',
        behavior: 'join',
      } as const
      const run = await client.start(workflow, {}, { unique })
      await runtime.store.failRun({ runId: run.id, error: new Error('failed') })
      await client.start(workflow, {}, { unique })
      const before = await client.get(run.id)
      await expect(client.retry(run.id)).rejects.toThrow()
      expect(await client.get(run.id)).toEqual(before)
    })

    it('retries nested workflow failures without repeating completed child workflows', async () => {
      const runtime = await setup()
      let fail = true
      const calls: number[] = []
      const child = defineWorkflow({
        name: 'nested-child',
        input: t.number(),
        output: t.number(),
      })
        .activity('work', { input: t.number(), output: t.number() })
        .build()
      const childImpl = implementWorkflow(child)
        .work(async (_ctx, value) => {
          calls.push(value)
          if (fail && value === 2) throw new Error('nested failed')
          return value
        })
        .finish((_ctx, outputs) => outputs.work)
      const parent = defineWorkflow({
        name: 'nested-parent',
        input: t.array(t.number()),
      })
        .mapWorkflow('children', child, { item: t.number(), concurrency: 1 })
        .build()
      const parentImpl = implementWorkflow(parent)
        .children(child, {
          items: (_ctx, _outputs, input) => input,
          input: (_ctx, _outputs, item) => item,
        })
        .finish((_ctx, outputs) => outputs.children)
      const workflows = [parentImpl, childImpl]
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(parent, [1, 2])
      const coordinate = () =>
        runWorkflowWorker({
          ...runtime,
          workflows,
          workerId: 'coordinator',
          reaping: false,
          runTimeouts: false,
        })
      const execute = () =>
        runExecutionWorker({
          ...runtime,
          workflows,
          tasks: [],
          workerId: 'executor',
          reaping: false,
        })
      await coordinate()
      await execute()
      await coordinate()
      await execute()
      await coordinate()
      const before = await client.getFamily(run.id)
      expect((await client.get(run.id))?.run.status).toBe('failed')
      fail = false
      await client.retry(run.id)
      await coordinate()
      await execute()
      await coordinate()
      expect((await client.get(run.id))?.run.status).toBe('completed')
      expect((await client.getFamily(run.id)).map(({ run }) => run.id)).toEqual(
        before.map(({ run }) => run.id),
      )
      expect(calls).toEqual([1, 2, 2])
    })

    it('recovers timeout-cancelled work with a fresh timeout epoch', async () => {
      const runtime = await setup()
      const workflow = defineWorkflow({
        name: 'timeout-retry',
        input: t.number(),
        timeout: '1h',
      })
        .activity('work', { input: t.number(), output: t.number() })
        .build()
      const impl = implementWorkflow(workflow)
        .work(async (_ctx, value) => value)
        .finish((_ctx, outputs) => outputs.work)
      const client = createWorkflowRuntimeClient(runtime)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(Date.now() - 7_200_000))
      const run = await client.start(workflow, 42)
      vi.useRealTimers()
      if ('connection' in runtime) {
        // The SQL adapter's monotonic clock deliberately resists moving the
        // process clock backwards, so age this fixture explicitly.
        await runtime.connection.query(
          "UPDATE workflow_runs SET created_at = now() - interval '2 hours', active_since = now() - interval '2 hours' WHERE id = $1",
          [run.id],
        )
      }
      const coordinate = () =>
        runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
          reaping: false,
          runTimeouts: false,
        })
      await coordinate()
      const loadSnapshot = vi.spyOn(runtime.store, 'loadRunSnapshot')
      const loadRuns = vi.spyOn(runtime.store, 'loadRuns')
      expect(
        await timeoutExpiredWorkflowRuns({ ...runtime, workflows: [impl] }),
      ).toEqual({ timedOut: 1 })
      expect(loadSnapshot).toHaveBeenCalledTimes(1)
      expect(loadRuns).not.toHaveBeenCalled()
      loadSnapshot.mockRestore()
      loadRuns.mockRestore()
      const before = (await client.get(run.id))!
      expect(before.attempts[0]?.status).toBe('cancelled')
      const retry = await client.retry(run.id)
      expect(
        retry.activeSince.getTime() - retry.createdAt.getTime(),
      ).toBeGreaterThan(3_600_000)
      expect(
        await timeoutExpiredWorkflowRuns({ ...runtime, workflows: [impl] }),
      ).toEqual({ timedOut: 0 })
      await coordinate()
      await runExecutionWorker({
        ...runtime,
        workflows: [impl],
        tasks: [],
        workerId: 'executor',
        reaping: false,
      })
      await coordinate()
      const after = (await client.get(run.id))!
      expect(after.run.output).toBe(42)
      expect(after.attempts[0]).toEqual(before.attempts[0])
      expect(after.attempts.map((attempt) => attempt.status)).toEqual([
        'cancelled',
        'completed',
      ])
    })

    it('rejects retry while an old attempt still holds a lease', async () => {
      const runtime = await setup()
      const task = defineTask({
        name: 'claimed-task',
        input: t.number(),
        output: t.number(),
      })
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(task, 42)
      const claim = await runtime.attemptExecutor.claim({
        taskNames: [task.name],
        workflowNames: [],
        workerId: 'old-worker',
        leaseMs: 30_000,
      })
      expect(claim).not.toBeNull()
      await runtime.store.cancelNonTerminalRunNodes({ runId: run.id })
      await runtime.store.failRun({
        runId: run.id,
        error: new Error('timed out'),
      })
      const before = await client.get(run.id)
      await expect(client.retry(run.id)).rejects.toThrow('active attempt')
      expect(await client.get(run.id)).toEqual(before)
      await runtime.attemptExecutor.ack(claim!)
      expect((await client.retry(run.id)).id).toBe(run.id)
    })

    it('continues siblings after a map input callback fails and retries that callback', async () => {
      const runtime = await setup()
      let fail = true
      const task = defineTask({
        name: 'callback-task',
        input: t.number(),
        output: t.number(),
      })
      const taskImpl = implementTask(task, {
        handler: async (_ctx, value) => value,
      })
      const workflow = defineWorkflow({
        name: 'callback-map',
        input: t.array(t.number()),
      })
        .mapTask('items', task, { item: t.number(), concurrency: 1 })
        .build()
      const impl = implementWorkflow(workflow)
        .items(task, {
          items: (_ctx, _outputs, input) => input,
          input: (_ctx, _outputs, item) => {
            if (fail && item === 1) throw new Error('mapper failed')
            return item
          },
        })
        .finish((_ctx, outputs) => outputs.items)
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, [1, 2])
      const coordinate = () =>
        runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
          reaping: false,
          runTimeouts: false,
        })
      const execute = () =>
        runExecutionWorker({
          ...runtime,
          workflows: [impl],
          tasks: [taskImpl],
          workerId: 'executor',
          reaping: false,
        })
      await coordinate()
      await execute()
      await coordinate()
      const before = (await client.get(run.id))!
      expect(before.run.status).toBe('failed')
      expect(before.children.map((child) => child.status)).toEqual([
        'failed',
        'completed',
      ])
      fail = false
      await client.retry(run.id)
      await coordinate()
      await execute()
      await coordinate()
      const after = (await client.get(run.id))!
      expect(after.run.status).toBe('completed')
      expect(after.children[1]).toEqual(before.children[1])
    })

    it('preserves completed checkpoints containing historical failed descendants', async () => {
      const runtime = await setup()
      const child = defineWorkflow({
        name: 'legacy-child',
        input: t.number(),
        output: t.number(),
      }).build()
      const workflow = defineWorkflow({
        name: 'legacy-parent',
        input: t.array(t.number()),
      })
        .mapWorkflow('legacy', child, { item: t.number() })
        .build()
      const impl = implementWorkflow(workflow)
        .legacy(child, {
          items: (_ctx, _outputs, input) => input,
          input: (_ctx, _outputs, item) => item,
        })
        .finish(() => 'done')
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, [1])
      const coordinate = () =>
        runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
          reaping: false,
          runTimeouts: false,
        })
      await coordinate()
      const mapped = (await client.get(run.id))!.children[0]!
      await runtime.store.failRun({
        runId: mapped.childRunId!,
        error: new Error('historical failure'),
      })
      await runtime.store.failNodeChild({
        runId: run.id,
        nodeName: 'legacy',
        childKey: mapped.childKey,
        error: new Error('historical failure'),
      })
      // This persisted shape was legal under the removed wait-settled mode.
      await runtime.store.completeNode({
        runId: run.id,
        nodeName: 'legacy',
        output: { items: [] },
      })
      await runtime.store.failRun({
        runId: run.id,
        error: new Error('finish failed'),
      })
      const before = await client.get(mapped.childRunId!)
      await client.retry(run.id)
      await coordinate()
      expect((await client.get(run.id))?.run.output).toBe('done')
      expect(await client.get(mapped.childRunId!)).toEqual(before)
    })

    it('ignores dead commands listed before the same run was retried', async () => {
      const runtime = await setup(1)
      const client = createWorkflowRuntimeClient(runtime)
      const workflow = defineWorkflow({
        name: 'dead-retry',
        input: t.object({}),
      }).build()
      const run = await client.start(workflow, {})
      const claimed = await runtime.runCoordinationExecutor.claim({
        workflowNames: [workflow.name],
        workerId: 'coordinator',
        leaseMs: 30_000,
      })
      expect(claimed).not.toBeNull()
      await runtime.runCoordinationExecutor.release(claimed!, {
        error: new Error('dead'),
      })
      const staleBatch = await runtime.store.listUnreapedDeadCommands()
      expect(staleBatch).toHaveLength(1)
      const loadSnapshot = vi.spyOn(runtime.store, 'loadRunSnapshot')
      const loadRuns = vi.spyOn(runtime.store, 'loadRuns')
      await reapDeadWorkflowCommands(runtime)
      expect(loadSnapshot).toHaveBeenCalledTimes(1)
      expect(loadRuns).not.toHaveBeenCalled()
      loadSnapshot.mockRestore()
      loadRuns.mockRestore()
      await client.retry(run.id)
      const retried = await client.get(run.id)
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

    it.runIf(adapter === 'postgres')(
      'keeps retry query count constant as the failed family grows',
      async () => {
        const runtime = await setup()
        if (!('connection' in runtime)) throw new Error('Postgres required')
        const child = defineWorkflow({
          name: 'batch-child',
          input: t.number(),
          output: t.number(),
        }).build()
        const workflow = defineWorkflow({
          name: 'batch-parent',
          input: t.array(t.number()),
        })
          .mapWorkflow('children', child, { item: t.number() })
          .build()
        const childImpl = implementWorkflow(child).finish(() => {
          throw new Error('failed')
        })
        const impl = implementWorkflow(workflow)
          .children(child, {
            items: (_ctx, _outputs, input) => input,
            input: (_ctx, _outputs, item) => item,
          })
          .finish((_ctx, outputs) => outputs.children)
        const client = createWorkflowRuntimeClient(runtime)
        let queries = 0
        const wrap = (
          connection: typeof runtime.connection,
        ): typeof runtime.connection => ({
          query(sql, params) {
            queries++
            return connection.query(sql, params)
          },
          transaction: (handler) =>
            connection.transaction((tx) => handler(wrap(tx))),
        })
        const measuredClient = createWorkflowRuntimeClient(
          createPostgresWorkflowRuntime({
            connection: wrap(runtime.connection),
          }),
        )
        const counts: number[] = []
        for (const size of [1, 8]) {
          const run = await client.start(
            workflow,
            Array.from({ length: size }, (_, index) => index),
          )
          await runWorkflowWorker({
            ...runtime,
            workflows: [impl, childImpl],
            workerId: 'coordinator',
            reaping: false,
            runTimeouts: false,
          })
          expect((await client.get(run.id))?.run.status).toBe('failed')
          queries = 0
          await measuredClient.retry(run.id)
          counts.push(queries)
          const detail = (await client.getDetail(run.id))!
          expect(detail.run.activeSince).toBeInstanceOf(Date)
          expect(detail.childRuns).toHaveLength(size)
          for (const nested of detail.childRuns)
            expect(nested.activeSince).toBeInstanceOf(Date)
        }
        expect(counts[1]).toBe(counts[0])
      },
    )

    it.runIf(adapter === 'postgres')(
      'rolls back the whole retry when continuation enqueue fails',
      async () => {
        const runtime = await setup()
        if (!('connection' in runtime)) throw new Error('Postgres required')
        const client = createWorkflowRuntimeClient(runtime)
        const workflow = defineWorkflow({
          name: 'retry-rollback',
          input: t.object({}),
        }).build()
        const run = await client.start(workflow, {})
        await runtime.store.failRun({
          runId: run.id,
          error: new Error('failed'),
        })
        const before = await client.get(run.id)
        const wrap = (
          connection: typeof runtime.connection,
        ): typeof runtime.connection => ({
          query(sql, params) {
            if (/INSERT INTO workflow_commands/.test(sql))
              throw new Error('enqueue failed')
            return connection.query(sql, params)
          },
          transaction: (handler) =>
            connection.transaction((tx) => handler(wrap(tx))),
        })
        const failing = createWorkflowRuntimeClient(
          createPostgresWorkflowRuntime({
            connection: wrap(runtime.connection),
          }),
        )
        await expect(failing.retry(run.id)).rejects.toThrow('enqueue failed')
        expect(await client.get(run.id)).toEqual(before)
        expect((await client.retry(run.id)).id).toBe(run.id)
      },
    )
  })
}
