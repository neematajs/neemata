import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../src/implement/index.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  runExecutionWorker,
  runWorkflowWorker,
} from '../../src/effect/index.ts'
import { defineSchedule } from '../../src/index.ts'
import {
  createWorkflowRuntimeClient,
  type RunSnapshot,
} from '../../src/runtime/index.ts'
import { fromPromise } from '../support/effect.ts'
import {
  createPostgresWorkflowHarness,
  createTestContext,
  createTestName,
  postgresTarget,
  requireServiceEnv,
  wait,
  type PostgresWorkflowHarness,
} from './helpers.ts'

requireServiceEnv(postgresTarget)

describe.skipIf(!postgresTarget.url)(
  '@nmtjs/workflows Postgres integration',
  () => {
    const harnesses: PostgresWorkflowHarness[] = []

    afterEach(async () => {
      await Promise.allSettled(
        harnesses.splice(0).map((harness) => harness.cleanup()),
      )
    })

    async function createHarness() {
      const harness = await createPostgresWorkflowHarness(postgresTarget)
      harnesses.push(harness)
      return harness
    }

    it('prunes completed workflow trees and dead commands while preserving live runs', async () => {
      const { runtime, pool } = await createHarness()
      const context = createTestContext()
      const childWorkflow = defineWorkflow({
        name: createTestName('postgres-retention-child'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      }).build()
      const parentWorkflow = defineWorkflow({
        name: createTestName('postgres-retention-parent'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .workflow('child', childWorkflow)
        .build()
      const liveWorkflow = defineWorkflow({
        name: createTestName('postgres-retention-live'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .activity('hold', {
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        })
        .build()
      const childImpl = implementWorkflow(childWorkflow, {
        pool: 'test',
      }).finish((_outputs, input) => fromPromise(() => ({ text: input.text })))
      const parentImpl = implementWorkflow(parentWorkflow, { pool: 'test' })
        .child(childWorkflow)
        .finish(({ child }) => fromPromise(() => child))
      const liveImpl = implementWorkflow(liveWorkflow, { pool: 'test' })
        .hold((input) => fromPromise(async () => input))
        .finish(({ hold }) => fromPromise(() => hold))
      const client = createWorkflowRuntimeClient(runtime)
      const completedRuns = await Promise.all([
        client.start(parentWorkflow, { text: 'alpha' }),
        client.start(parentWorkflow, { text: 'beta' }),
      ])
      const completedSnapshots = await runWorkersUntilCompleted({
        runtime,
        context,
        workflows: [parentImpl, childImpl],
        runIds: completedRuns.map((run) => run.id),
        workerCount: 2,
      })
      const completedTreeIds = [
        ...completedRuns.map((run) => run.id),
        ...completedSnapshots.flatMap((snapshot) =>
          snapshot.children
            .map((child) => child.childRunId)
            .filter((id): id is string => id !== undefined),
        ),
      ]
      const liveRun = await client.start(liveWorkflow, { text: 'live' })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [liveImpl],
        workerId: 'retention-live-worker',
        idleDelayMs: 10,
      })
      const deadCommandRun = await runtime.store.createRun({
        workflowName: createTestName('postgres-retention-dead-command'),
        input: {},
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: deadCommandRun.id,
        workflowName: deadCommandRun.workflowName,
      })
      await pool.query(
        `
          UPDATE workflow_commands
          SET delivery_count = 1,
              dead_at = now() - interval '1 second'
          WHERE run_id = $1
        `,
        [deadCommandRun.id],
      )
      await wait(5)

      const pruned = await client.pruneRuns({
        olderThan: new Date(),
        batchSize: 1,
      })

      expect(pruned).toStrictEqual({ deleted: 2 })
      await expect(
        runtime.store.loadRunSnapshot(liveRun.id),
      ).resolves.toBeDefined()
      await expect(
        runtime.store.loadRunSnapshot(deadCommandRun.id),
      ).resolves.toBeDefined()
      await expectGone(pool, 'workflow_runs', 'id', completedTreeIds)
      await expectGone(pool, 'workflow_nodes', 'run_id', completedTreeIds)
      await expectGone(pool, 'workflow_attempts', 'run_id', completedTreeIds)
      await expectGone(pool, 'workflow_run_leases', 'run_id', completedTreeIds)
      await expectGone(pool, 'workflow_commands', 'run_id', [
        ...completedTreeIds,
        deadCommandRun.id,
      ])
      const orphanRuns = await pool.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM workflow_runs child
        LEFT JOIN workflow_runs parent ON parent.id = child.parent_run_id
        WHERE child.parent_run_id IS NOT NULL
          AND parent.id IS NULL
      `)
      expect(orphanRuns.rows[0]?.count).toBe(0)
    }, 30_000)

    it('executes multi-worker activity and task effects exactly once', async () => {
      const { runtime } = await createHarness()
      const context = createTestContext()
      const effects = new Map<string, number>()
      const task = defineTask({
        name: createTestName('postgres-effect-task'),
        input: Schema.Struct({ runKey: Schema.String, item: Schema.String }),
        output: Schema.Struct({ id: Schema.String }),
      })
      const workflow = defineWorkflow({
        name: createTestName('postgres-effect-workflow'),
        input: Schema.Struct({
          runKey: Schema.String,
          items: Schema.Array(Schema.String),
        }),
        output: Schema.Struct({ count: Schema.Number }),
      })
        .activity('prepare', {
          input: Schema.Struct({ runKey: Schema.String }),
          output: Schema.Struct({ prefix: Schema.String }),
        })
        .mapTask('items', task, {
          item: Schema.String,

          concurrency: 3,
        })
        .activity('finalize', {
          input: Schema.Struct({ runKey: Schema.String, count: Schema.Number }),
          output: Schema.Struct({ count: Schema.Number }),
        })
        .build()
      const taskImpl = implementTask(task, {
        pool: 'test',
        handler: (input) =>
          fromPromise(async () => {
            increment(effects, `${input.runKey}:item:${input.item}`)
            return { id: `${input.runKey}:${input.item}` }
          }),
      })
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
        .prepare((input) =>
          fromPromise(async () => {
            increment(effects, `${input.runKey}:prepare`)
            return { prefix: input.runKey }
          }),
        )
        .items(task, {
          items: (_outputs, input) => input.items,
          input: ({ prepare }, item) => ({
            runKey: prepare.prefix,
            item,
          }),
        })
        .finalize(
          (input) =>
            fromPromise(async () => {
              increment(effects, `${input.runKey}:finalize`)
              return { count: input.count }
            }),
          {
            input: ({ prepare, items }) => ({
              runKey: prepare.prefix,
              count: items.items.length,
            }),
          },
        )
        .finish(({ finalize }) =>
          fromPromise(() => ({ count: finalize.count })),
        )
      const client = createWorkflowRuntimeClient(runtime)
      const inputs = Array.from({ length: 20 }, (_, index) => ({
        runKey: `run-${index}`,
        items: ['a', 'b', 'c'],
      }))
      const runs = await Promise.all(
        inputs.map((input) => client.start(workflow, input)),
      )

      const snapshots = await runWorkersUntilCompleted({
        runtime,
        context,
        workflows: [workflowImpl],
        tasks: [taskImpl],
        runIds: runs.map((run) => run.id),
        workerCount: 3,
        leaseMs: 500,
      })

      expect(snapshots.map((snapshot) => snapshot.run.status)).toStrictEqual(
        Array.from({ length: inputs.length }, () => 'completed'),
      )
      for (const input of inputs) {
        expect(effects.get(`${input.runKey}:prepare`)).toBe(1)
        expect(effects.get(`${input.runKey}:finalize`)).toBe(1)
        for (const item of input.items) {
          expect(effects.get(`${input.runKey}:item:${item}`)).toBe(1)
        }
      }
    }, 60_000)

    it('redelivers an unacked activity after a crashed worker lease expires', async () => {
      const { runtime } = await createHarness()
      const context = createTestContext()
      let calls = 0
      const workflow = defineWorkflow({
        name: createTestName('postgres-crash-redelivery-workflow'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .activity('content', {
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        })
        .build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
        .content((input) =>
          fromPromise(async () => {
            calls += 1
            return { text: `content:${input.text}` }
          }),
        )
        .finish(({ content }) => fromPromise(() => ({ text: content.text })))
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, { text: 'alpha' })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-crash',
      })
      const claimed = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-crashed',
        workflowNames: [workflow.name],
        activityNames: ['content'],
        leaseMs: 50,
      })
      expect(claimed).not.toBeNull()

      await wait(150)
      await runExecutionWorker({
        tasks: [],
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'activity-reclaimer',
        leaseMs: 200,
        idleDelayMs: 20,
      })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-finish',
      })

      const snapshot = await runtime.store.loadRunSnapshot(run.id)
      expect(calls).toBe(1)
      expect(snapshot?.run.status).toBe('completed')
      expect(snapshot?.run.output).toStrictEqual({ text: 'content:alpha' })
    }, 30_000)

    it('keeps long activity work alive with heartbeats across lease expiry', async () => {
      const { runtime } = await createHarness()
      const context = createTestContext()
      let calls = 0
      const workflow = defineWorkflow({
        name: createTestName('postgres-heartbeat-workflow'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .activity('content', {
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        })
        .build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
        .content((input) =>
          fromPromise(async () => {
            calls += 1
            await wait(360)
            return { text: `content:${input.text}` }
          }),
        )
        .finish(({ content }) => fromPromise(() => ({ text: content.text })))
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, { text: 'alpha' })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-heartbeat',
      })

      await Promise.all([
        runExecutionWorker({
          tasks: [],
          ...runtime,
          context,
          workflows: [workflowImpl],
          workerId: 'activity-heartbeat-1',
          leaseMs: 180,
          idleDelayMs: 80,
        }),
        runExecutionWorker({
          tasks: [],
          ...runtime,
          context,
          workflows: [workflowImpl],
          workerId: 'activity-heartbeat-2',
          leaseMs: 180,
          idleDelayMs: 80,
        }),
      ])
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-heartbeat-finish',
      })

      const snapshot = await runtime.store.loadRunSnapshot(run.id)
      expect(calls).toBe(1)
      expect(snapshot?.run.status).toBe('completed')
      expect(snapshot?.attempts).toHaveLength(1)
      expect(snapshot?.attempts[0]?.status).toBe('completed')
    }, 30_000)

    it('aborts completion after activity lease loss and lets another worker finish', async () => {
      const { pool, runtime } = await createHarness()
      const context = createTestContext()
      let calls = 0
      let firstStarted!: () => void
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve
      })
      const workflow = defineWorkflow({
        name: createTestName('postgres-lease-loss-workflow'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .activity('content', {
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        })
        .build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
        .content((input) =>
          fromPromise(async () => {
            calls += 1
            if (calls === 1) {
              firstStarted()
              await wait(220)
              return { text: `stale:${input.text}` }
            }
            return { text: `fresh:${input.text}` }
          }),
        )
        .finish(({ content }) => fromPromise(() => ({ text: content.text })))
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, { text: 'alpha' })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-lease-loss',
      })

      const staleWorker = runExecutionWorker({
        tasks: [],
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'activity-stale',
        leaseMs: 60,
        idleDelayMs: 20,
        reaping: false,
      })
      await firstStartedPromise
      await pool.query(
        `
          UPDATE workflow_commands
          SET lease_owner = 'activity-stealer',
              lease_token = 'stolen',
              lease_expires_at = now() + interval '100 milliseconds'
          WHERE kind = 'activity' AND run_id = $1
        `,
        [run.id],
      )

      await expect(staleWorker).resolves.toStrictEqual({ processed: 0 })
      await wait(120)
      await runExecutionWorker({
        tasks: [],
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'activity-fresh',
        leaseMs: 200,
        idleDelayMs: 20,
      })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-lease-loss-finish',
      })

      const snapshot = await runtime.store.loadRunSnapshot(run.id)
      expect(calls).toBe(2)
      expect(snapshot?.run.status).toBe('completed')
      expect(snapshot?.run.output).toStrictEqual({ text: 'fresh:alpha' })
      expect(snapshot?.attempts).toHaveLength(1)
      expect(snapshot?.attempts[0]?.status).toBe('completed')
    }, 30_000)

    it('cancels parent and child workflows and absorbs late in-flight completion', async () => {
      const { pool, runtime } = await createHarness()
      const context = createTestContext()
      let releaseSlow!: () => void
      let slowStarted!: () => void
      const slowStartedPromise = new Promise<void>((resolve) => {
        slowStarted = resolve
      })
      const releaseSlowPromise = new Promise<void>((resolve) => {
        releaseSlow = resolve
      })
      const childWorkflow = defineWorkflow({
        name: createTestName('postgres-cancel-child'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .activity('slow', {
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        })
        .build()
      const parentWorkflow = defineWorkflow({
        name: createTestName('postgres-cancel-parent'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .workflow('child', childWorkflow)
        .build()
      const childImpl = implementWorkflow(childWorkflow, { pool: 'test' })
        .slow(
          (input) =>
            fromPromise(async () => {
              slowStarted()
              await releaseSlowPromise
              return { text: `late:${input.text}` }
            }),
          {
            input: (_outputs, input) => ({ text: input.text }),
          },
        )
        .finish(({ slow }) => fromPromise(() => ({ text: slow.text })))
      const parentImpl = implementWorkflow(parentWorkflow, { pool: 'test' })
        .child(childWorkflow, {
          input: (_outputs, input) => ({ text: input.text }),
        })
        .finish(({ child }) => fromPromise(() => ({ text: child.text })))
      const client = createWorkflowRuntimeClient(runtime)
      const parentRun = await client.start(parentWorkflow, { text: 'alpha' })

      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [parentImpl, childImpl],
        workerId: 'coordinator-cancel-prime',
        leaseMs: 200,
        idleDelayMs: 10,
      })
      const activityWorker = runExecutionWorker({
        tasks: [],
        ...runtime,
        context,
        workflows: [childImpl],
        workerId: 'activity-cancel-late',
        leaseMs: 500,
      })
      await slowStartedPromise

      await client.cancel(parentRun.id)
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [parentImpl, childImpl],
        workerId: 'coordinator-cancel',
        leaseMs: 200,
        idleDelayMs: 10,
      })

      const cancelledParent = await runtime.store.loadRunSnapshot(parentRun.id)
      const childRunId = cancelledParent?.children[0]?.childRunId
      expect(childRunId).toBeDefined()
      const cancelledChild = await runtime.store.loadRunSnapshot(childRunId!)
      expect(cancelledParent?.run.status).toBe('cancelled')
      expect(cancelledParent?.nodes[0]?.status).toBe('cancelled')
      expect(cancelledChild?.run.status).toBe('cancelled')
      expect(cancelledChild?.nodes[0]?.status).toBe('cancelled')

      const unclaimed = await pool.query<{ count: number }>(
        `
          SELECT count(*)::int AS count
          FROM workflow_commands
          WHERE run_id = ANY($1::uuid[])
            AND lease_token IS NULL
        `,
        [[parentRun.id, childRunId]],
      )
      expect(unclaimed.rows[0]?.count).toBe(0)

      releaseSlow()
      await expect(activityWorker).resolves.toStrictEqual({ processed: 1 })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [parentImpl, childImpl],
        workerId: 'coordinator-cancel-after-late',
        leaseMs: 200,
        idleDelayMs: 10,
      })

      const finalParent = await runtime.store.loadRunSnapshot(parentRun.id)
      const finalChild = await runtime.store.loadRunSnapshot(childRunId!)
      expect(finalParent?.run.status).toBe('cancelled')
      expect(finalParent?.run.output).toBeUndefined()
      expect(finalChild?.run.status).toBe('cancelled')
      expect(finalChild?.run.output).toBeUndefined()
    }, 30_000)

    it('delivers cancellation to an in-flight activity via heartbeat without retrying it', async () => {
      const { pool, runtime } = await createHarness()
      const context = createTestContext()
      const leaseMs = 180
      let calls = 0
      let cancelRequestedAt = 0
      let abortAfterMs: number | undefined
      let abortReason: unknown
      let activityStarted!: () => void
      const activityStartedPromise = new Promise<void>((resolve) => {
        activityStarted = resolve
      })
      const workflow = defineWorkflow({
        name: createTestName('postgres-cancel-signal-workflow'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
        .activity('slow', {
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        })
        .build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
        .slow((input, lifecycle) =>
          fromPromise(async () => {
            calls += 1
            activityStarted()
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, leaseMs * 3)
              lifecycle?.signal.addEventListener(
                'abort',
                () => {
                  abortAfterMs = Date.now() - cancelRequestedAt
                  abortReason = lifecycle.signal.reason
                  clearTimeout(timeout)
                  resolve()
                },
                { once: true },
              )
            })
            return { text: `late:${input.text}` }
          }),
        )
        .finish(({ slow }) => fromPromise(() => ({ text: slow.text })))
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, { text: 'alpha' })
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-cancel-signal-prime',
        leaseMs,
      })

      const activityWorker = runExecutionWorker({
        tasks: [],
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'activity-cancel-signal',
        leaseMs,
      })
      await activityStartedPromise

      cancelRequestedAt = Date.now()
      await client.cancel(run.id)
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'coordinator-cancel-signal',
        leaseMs,
        idleDelayMs: 10,
      })
      await expect(activityWorker).resolves.toStrictEqual({ processed: 1 })

      const snapshot = await runtime.store.loadRunSnapshot(run.id)
      const commands = await pool.query<{ count: number }>(
        `
          SELECT count(*)::int AS count
          FROM workflow_commands
          WHERE run_id = $1
        `,
        [run.id],
      )
      expect(abortReason).toMatchObject({ type: 'cancelled' })
      expect(abortAfterMs).toBeLessThanOrEqual(Math.floor(leaseMs / 3) + 100)
      expect(calls).toBe(1)
      expect(snapshot?.run.status).toBe('cancelled')
      expect(snapshot?.attempts).toHaveLength(1)
      expect(commands.rows[0]?.count).toBe(0)
    }, 30_000)

    it('keeps idempotent starts and duplicate continues consistent under contention', async () => {
      const { pool, runtime } = await createHarness()
      const context = createTestContext()
      let finishCalls = 0
      const workflow = defineWorkflow({
        name: createTestName('postgres-contention-workflow'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      }).build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' }).finish(
        (_outputs, input) =>
          fromPromise(() => {
            finishCalls += 1
            return { text: input.text }
          }),
      )
      const client = createWorkflowRuntimeClient(runtime)
      const starts = await Promise.all(
        Array.from({ length: 20 }, () =>
          client.start(
            workflow,
            { text: 'alpha' },
            { idempotencyKey: ['contention', workflow.name, 'alpha'] },
          ),
        ),
      )
      const runIds = new Set(starts.map((run) => run.id))
      expect(runIds.size).toBe(1)
      const runId = starts[0]!.id
      await Promise.all(
        Array.from({ length: 20 }, () =>
          runtime.runCoordinationExecutor.enqueue({
            kind: 'continueRun',
            runId,
            workflowName: workflow.name,
          }),
        ),
      )

      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          runWorkflowWorker({
            ...runtime,
            context,
            workflows: [workflowImpl],
            workerId: `coordinator-contention-${index}`,
            leaseMs: 200,
            idleDelayMs: 10,
          }),
        ),
      )

      const rows = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM workflow_runs',
      )
      const snapshot = await runtime.store.loadRunSnapshot(runId)
      expect(rows.rows[0]?.count).toBe(1)
      expect(finishCalls).toBe(1)
      expect(snapshot?.run.status).toBe('completed')
      expect(snapshot?.run.output).toStrictEqual({ text: 'alpha' })
    }, 30_000)

    it('fires a due schedule exactly once across concurrent coordinator workers', async () => {
      const { runtime } = await createHarness()
      const context = createTestContext()
      const workflow = defineWorkflow({
        name: createTestName('postgres-scheduled-once'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      }).build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' }).finish(
        (_outputs, input) => fromPromise(() => ({ text: input.text })),
      )
      const schedule = defineSchedule({
        name: createTestName('postgres-schedule-once'),
        runnable: workflow,
        input: { text: 'alpha' },
        every: '1s',
        immediately: true,
      })

      await runtime.scheduler!.reconcile([schedule])
      await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          runWorkflowWorker({
            ...runtime,
            context,
            workflows: [workflowImpl],
            workerId: `schedule-coordinator-${index}`,
            scheduling: { everyMs: 0, batchSize: 10 },
            idleDelayMs: 10,
          }),
        ),
      )

      const runs = await runtime.store.listRuns({
        tags: { schedule: schedule.name },
      })
      expect(runs.runs).toHaveLength(1)
      expect(runs.runs[0]?.status).toBe('completed')
      expect(runs.runs[0]?.output).toStrictEqual({ text: 'alpha' })
    }, 30_000)

    it('stops firing disabled schedules', async () => {
      const { runtime } = await createHarness()
      const context = createTestContext()
      const workflow = defineWorkflow({
        name: createTestName('postgres-disabled-schedule-workflow'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      }).build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' }).finish(
        (_outputs, input) => fromPromise(() => ({ text: input.text })),
      )
      const schedule = defineSchedule({
        name: createTestName('postgres-disabled-schedule'),
        runnable: workflow,
        input: { text: 'alpha' },
        // long interval: only the immediate slot fires during the test;
        // a hot interval keeps re-feeding the worker loop and it never idles out
        every: '1m',
        immediately: true,
      })

      await runtime.scheduler!.reconcile([schedule])
      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'schedule-disable-first',
        scheduling: { everyMs: 0, batchSize: 10 },
        idleDelayMs: 10,
      })
      await runtime.scheduler!.setEnabled(schedule.name, false)
      // probe far past the next slot: due if it were still enabled, so a zero
      // fire count isolates the enabled predicate from clock timing
      const probe = await runtime.scheduler!.fireDue({
        now: new Date(Date.now() + 300_000),
        limit: 10,
      })
      expect(probe.fired).toBe(0)

      const runs = await runtime.store.listRuns({
        tags: { schedule: schedule.name },
      })
      expect(runs.runs).toHaveLength(1)
    }, 30_000)

    it('keeps delayed starts visible before command dispatch is due', async () => {
      const { runtime } = await createHarness()
      const context = createTestContext()
      const workflow = defineWorkflow({
        name: createTestName('postgres-delayed-start'),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      }).build()
      const workflowImpl = implementWorkflow(workflow, { pool: 'test' }).finish(
        (_outputs, input) => fromPromise(() => ({ text: input.text })),
      )
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(
        workflow,
        { text: 'alpha' },
        { startAt: new Date(Date.now() + 200) },
      )

      await runWorkflowWorker({
        ...runtime,
        context,
        workflows: [workflowImpl],
        workerId: 'delayed-start-before',
        idleDelayMs: 20,
      })
      const queued = await runtime.store.loadRunSnapshot(run.id)
      expect(queued?.run.status).toBe('queued')

      await wait(250)
      const [completed] = await runWorkersUntilCompleted({
        runtime,
        context,
        workflows: [workflowImpl],
        runIds: [run.id],
        workerCount: 1,
      })
      expect(completed?.run.output).toStrictEqual({ text: 'alpha' })
    }, 30_000)
  },
)

type RunWorkersUntilCompletedInput = {
  readonly runtime: PostgresWorkflowHarness['runtime']
  readonly context: ReturnType<typeof createTestContext>
  readonly workflows: readonly WorkflowImplementation[]
  readonly tasks?: readonly TaskImplementation[]
  readonly runIds: readonly string[]
  readonly workerCount?: number
  readonly leaseMs?: number
}

async function runWorkersUntilCompleted(
  input: RunWorkersUntilCompletedInput,
): Promise<RunSnapshot[]> {
  const workerCount = input.workerCount ?? 2
  const tasks = input.tasks ?? []

  for (let round = 0; round < 20; round++) {
    await Promise.all([
      ...Array.from({ length: workerCount }, (_, index) =>
        runWorkflowWorker({
          ...input.runtime,
          context: input.context,
          workflows: input.workflows,
          workerId: `coordinator-${round}-${index}`,
          leaseMs: input.leaseMs ?? 300,
          idleDelayMs: 10,
        }),
      ),
      ...Array.from({ length: workerCount }, (_, index) =>
        runExecutionWorker({
          tasks: [],
          ...input.runtime,
          context: input.context,
          workflows: input.workflows,
          workerId: `activity-${round}-${index}`,
          leaseMs: input.leaseMs ?? 300,
          idleDelayMs: 10,
        }),
      ),
      ...Array.from(
        { length: tasks.length === 0 ? 0 : workerCount },
        (_, index) =>
          runExecutionWorker({
            workflows: [],
            ...input.runtime,
            context: input.context,
            tasks,
            workerId: `task-${round}-${index}`,
            leaseMs: input.leaseMs ?? 300,
            idleDelayMs: 10,
          }),
      ),
    ])

    const snapshots = await Promise.all(
      input.runIds.map(async (runId) => {
        const snapshot = await input.runtime.store.loadRunSnapshot(runId)
        if (!snapshot) throw new Error(`Missing workflow run [${runId}]`)
        return snapshot
      }),
    )
    if (snapshots.every((snapshot) => snapshot.run.status === 'completed')) {
      return snapshots
    }
  }

  const snapshots = await Promise.all(
    input.runIds.map((runId) => input.runtime.store.loadRunSnapshot(runId)),
  )
  throw new Error(
    `Workflow runs did not complete: ${snapshots
      .map((snapshot) => `${snapshot?.run.id}:${snapshot?.run.status}`)
      .join(', ')}`,
  )
}

function increment(counters: Map<string, number>, key: string) {
  counters.set(key, (counters.get(key) ?? 0) + 1)
}

async function expectGone(
  pool: PostgresWorkflowHarness['pool'],
  table: string,
  column: string,
  ids: readonly string[],
) {
  const rows = await pool.query<{ count: number }>(
    `
      SELECT count(*)::int AS count
      FROM ${table}
      WHERE ${column} = ANY($1::uuid[])
    `,
    [ids],
  )
  expect(rows.rows[0]?.count).toBe(0)
}
