import { expect, it } from 'vitest'
import * as z from 'zod'

import type { WorkflowRuntimeAdapter } from '../../src/runtime/index.ts'
import { defineTask, implementTask } from '../../src/index.ts'
import {
  createHandlerRunner,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runTaskAttempt,
} from '../../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../../src/runtime/worker.ts'

type FencedRuntime = WorkflowRuntimeAdapter &
  Required<Pick<WorkflowRuntimeAdapter, 'atomicCompletion'>>

// Lease expiry is judged on the adapter's clock (Redis server time), so the
// margin has to absorb a real round trip, not just a timer tick.
const LEASE_MS = 100
const LEASE_EXPIRED_MS = 250

const text = z.string()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Shared by the in-memory and Redis specs: both fence attempt settlement by
 * the queue claim instead of by a transaction.
 */
export function defineClaimFencingTests(
  createRuntime: (options?: {
    readonly maxDeliveries?: number
  }) => FencedRuntime,
) {
  function createTask() {
    const task = defineTask({
      name: 'fencing.claim',
      input: text,
      output: text,
    })
    let calls = 0
    const implementation = implementTask(task, {
      pool: 'test',
      handler: async (input) => `${input}:${++calls}`,
    })
    return { task, implementation }
  }

  const claim = (runtime: FencedRuntime, workerId: string, leaseMs: number) =>
    runtime.attemptExecutor.claim({
      workerId,
      workflowNames: [],
      taskNames: ['fencing.claim'],
      leaseMs,
    })

  async function loadAttempt(runtime: FencedRuntime, runId: string) {
    const snapshot = await runtime.store.loadRunSnapshot(runId)
    expect(snapshot?.attempts).toHaveLength(1)
    return snapshot!.attempts[0]!
  }

  it('refuses every settlement of a claim that was taken over', async () => {
    const runtime = createRuntime()
    const { task } = createTask()
    const run = await createWorkflowRuntimeClient(runtime).start(task, 'hi')

    const claimA = (await claim(runtime, 'A', LEASE_MS))!
    await wait(LEASE_EXPIRED_MS)
    const claimB = (await claim(runtime, 'B', 30_000))!
    expect(claimB.id).toBe(claimA.id)
    expect(claimB.leaseToken).not.toBe(claimA.leaseToken)

    // The attempt token is the same for both workers; only the claim differs.
    const { attemptId, leaseToken } = claimA.command
    expect(claimB.command.leaseToken).toBe(leaseToken)
    const error = new Error('from A')
    await runtime.atomicCompletion.run(
      async ({ store }) => {
        await expect(
          store.completeCurrentAttempt({ attemptId, leaseToken, output: 'A' }),
        ).resolves.toBeUndefined()
        await expect(
          store.failCurrentAttempt({ attemptId, leaseToken, error }),
        ).resolves.toBeUndefined()
        await expect(
          store.timeoutCurrentAttempt({ attemptId, leaseToken, error }),
        ).resolves.toBeUndefined()
      },
      claimA,
      runtime,
    )
    expect(await loadAttempt(runtime, run.id)).toMatchObject({
      status: 'started',
    })

    await runtime.atomicCompletion.run(
      async ({ store }) => {
        await expect(
          store.completeCurrentAttempt({ attemptId, leaseToken, output: 'B' }),
        ).resolves.toMatchObject({ status: 'completed', output: 'B' })
      },
      claimB,
      runtime,
    )
    expect(await loadAttempt(runtime, run.id)).toMatchObject({
      status: 'completed',
      output: 'B',
    })
  })

  it('a worker that stalled before settling commits nothing and ends cleanly', async () => {
    const runtime = createRuntime()
    const { task, implementation } = createTask()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(task, 'hi')

    let claimB: Awaited<ReturnType<typeof claim>> = null
    const workerA = runExecutionWorker({
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'A',
      leaseMs: LEASE_MS,
      reaping: false,
      atomicCompletion: {
        // A's handler has returned and its heartbeat has stopped; the stall
        // outlives the lease, so B takes the claim over before A settles.
        run: async (handler, claimed, context) => {
          await wait(LEASE_EXPIRED_MS)
          claimB = await claim(runtime, 'B', 30_000)
          return await runtime.atomicCompletion.run(handler, claimed, context)
        },
      },
    })
    await expect(workerA).resolves.toBeDefined()

    expect(claimB).not.toBeNull()
    expect(await loadAttempt(runtime, run.id)).toMatchObject({
      status: 'started',
    })
    expect((await client.get(run.id))!.run.status).not.toBe('completed')

    await runTaskAttempt({
      ...runtime,
      tasks: [implementation],
      workerId: 'B',
      handlers: createHandlerRunner(),
      claimed: claimB!,
    })
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    // The handler ran once per worker: A produced `hi:1`, B produced `hi:2`.
    expect(snapshot.run.output).toBe('hi:2')
    // B's acknowledgement removed the command, so nothing is left to claim.
    await expect(claim(runtime, 'C', 30_000)).resolves.toBeNull()
  })

  // Settlement is the only fenced write, so once A has settled, both workers
  // go on to write the node, the run and the acknowledgement. Whichever order
  // they interleave in, those replays have to converge on A's one result.
  for (const order of ['before', 'after'] as const) {
    it(`completes once when the takeover runs ${order} the settled worker resumes`, async () => {
      const runtime = createRuntime()
      const { task, implementation } = createTask()
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(task, 'hi')

      let claimB: Awaited<ReturnType<typeof claim>> = null
      const runB = async (claimed: NonNullable<typeof claimB>) =>
        await runTaskAttempt({
          ...runtime,
          tasks: [implementation],
          workerId: 'B',
          handlers: createHandlerRunner(),
          claimed,
        })
      let resultB: Awaited<ReturnType<typeof runB>> | undefined
      const workerA = runExecutionWorker({
        ...runtime,
        workflows: [],
        tasks: [implementation],
        workerId: 'A',
        leaseMs: LEASE_MS,
        reaping: false,
        atomicCompletion: {
          run: (handler, claimed, context) =>
            runtime.atomicCompletion.run(
              (scoped) =>
                handler({
                  ...scoped,
                  store: {
                    ...scoped.store,
                    // A stalls with the attempt settled and every later
                    // write (node, run, ack) still ahead of it.
                    completeCurrentAttempt: async (params) => {
                      const settled =
                        await scoped.store.completeCurrentAttempt(params)
                      expect(settled).toMatchObject({ status: 'completed' })
                      await wait(LEASE_EXPIRED_MS)
                      claimB = await claim(runtime, 'B', 30_000)
                      if (order === 'before') resultB = await runB(claimB!)
                      return settled
                    },
                  },
                }),
              claimed,
              context,
            ),
        },
      })
      await expect(workerA).resolves.toBeDefined()
      expect(claimB).not.toBeNull()
      if (order === 'after') resultB = await runB(claimB!)
      expect(resultB).toEqual({ status: 'processed' })

      const snapshot = (await client.get(run.id))!
      expect(snapshot.run.status).toBe('completed')
      // B found the attempt settled and replayed its output without running
      // the handler again.
      expect(snapshot.run.output).toBe('hi:1')
      expect(await loadAttempt(runtime, run.id)).toMatchObject({
        status: 'completed',
        output: 'hi:1',
      })
      const stored = (await runtime.store.loadRunSnapshot(run.id))!
      expect(stored.nodes).toHaveLength(1)
      expect(stored.nodes[0]).toMatchObject({
        status: 'completed',
        output: 'hi:1',
      })
      await expect(claim(runtime, 'C', 30_000)).resolves.toBeNull()
    })
  }

  it('still settles without a claim when the reaper fails a dead attempt', async () => {
    const runtime = createRuntime({ maxDeliveries: 1 })
    const { task } = createTask()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(task, 'hi')

    expect(await claim(runtime, 'A', LEASE_MS)).not.toBeNull()
    await wait(LEASE_EXPIRED_MS)
    // The expired claim exhausts the delivery budget and dead-letters.
    await expect(claim(runtime, 'B', 30_000)).resolves.toBeNull()

    await expect(
      reapDeadWorkflowCommands({ ...runtime, workflows: [] }),
    ).resolves.toEqual({
      reaped: 1,
    })
    expect(await loadAttempt(runtime, run.id)).toMatchObject({
      status: 'failed',
    })
    expect((await client.get(run.id))!.run.status).toBe('failed')
  })

  it('a worker that stalled after failing its attempt leaves a manually retried run alone', async () => {
    const runtime = createRuntime({ maxDeliveries: 1 })
    const task = defineTask({
      name: 'fencing.claim',
      input: text,
      output: text,
    })
    let fail = true
    const implementation = implementTask(task, {
      pool: 'test',
      handler: async (input) => {
        if (fail) throw new Error('boom')
        return `${input}:retried`
      },
    })
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(task, 'hi')

    const errors: unknown[] = []
    let stalled = false
    const workerA = runExecutionWorker({
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'A',
      leaseMs: LEASE_MS,
      reaping: false,
      onError: (error) => errors.push(error),
      atomicCompletion: {
        run: (handler, claimed, context) =>
          runtime.atomicCompletion.run(
            (scoped) =>
              handler({
                ...scoped,
                store: {
                  ...scoped.store,
                  // A stalls between failing its attempt and failing the child
                  // while the claim dead-letters, the reaper fails the run
                  // and a manual retry reopens it.
                  failCurrentAttempt: async (params) => {
                    const failed = await scoped.store.failCurrentAttempt(params)
                    if (stalled) return failed
                    stalled = true
                    expect(failed).toMatchObject({ status: 'failed' })
                    await wait(LEASE_EXPIRED_MS)
                    await expect(
                      claim(runtime, 'B', 30_000),
                    ).resolves.toBeNull()
                    await reapDeadWorkflowCommands({
                      ...runtime,
                      workflows: [],
                    })
                    expect((await client.get(run.id))!.run.status).toBe(
                      'failed',
                    )
                    fail = false
                    await client.retry(run.id)
                    return failed
                  },
                },
              }),
            claimed,
            context,
          ),
      },
    })
    await expect(workerA).resolves.toBeDefined()
    expect(errors).toStrictEqual([])

    await runExecutionWorker({
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'C',
      reaping: false,
    })
    expect((await client.get(run.id))!.run).toMatchObject({
      status: 'completed',
      output: 'hi:retried',
    })
  })

  it('completes normally under a live claim', async () => {
    const runtime = createRuntime()
    const { task, implementation } = createTask()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(task, 'hi')

    await runExecutionWorker({
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'A',
      reaping: false,
    })

    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toBe('hi:1')
    expect(await loadAttempt(runtime, run.id)).toMatchObject({
      status: 'completed',
      output: 'hi:1',
    })
  })
}
