import type { Pool as PgPool } from 'pg'
import { t } from '@nmtjs/type'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  createPostgresWorkflowWakeEvents,
  type PostgresWorkflowWakeEvents,
} from '../../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../../src/adapters/postgres/testing.ts'
import { defineWorkflow, implementWorkflow } from '../../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../../src/runtime/index.ts'
import {
  createTestContainer,
  createTestName,
  postgresTarget,
  requireServiceEnv,
  wait,
} from './helpers.ts'

requireServiceEnv(postgresTarget)

const { Client, Pool } = pg

// Long enough that any assertion passing below proves the wake path fired
// instead of the poll/heartbeat fallback.
const LONG_DELAY_MS = 20_000

describe.skipIf(!postgresTarget.url)(
  '@nmtjs/workflows Postgres wake events',
  () => {
    const pools: PgPool[] = []
    const wakeEventHubs: PostgresWorkflowWakeEvents[] = []

    afterEach(async () => {
      await Promise.allSettled(
        wakeEventHubs.splice(0).map(async (hub) => hub.dispose()),
      )
      await Promise.allSettled(pools.splice(0).map((pool) => pool.end()))
    })

    // Deliberately no table truncation: integration spec files run in
    // parallel against one database, and this suite only touches runs it
    // created under unique names.
    async function createHarness() {
      const pool = new Pool({ connectionString: postgresTarget.url, max: 16 })
      pools.push(pool)
      const connection = createPostgresWorkflowConnection(pool)
      await installPostgresWorkflowSchemaForTesting(connection)
      return { runtime: createPostgresWorkflowRuntime({ connection }) }
    }

    async function createWakeEvents() {
      const wakeEvents = createPostgresWorkflowWakeEvents({
        connect: async () => {
          const client = new Client({ connectionString: postgresTarget.url })
          await client.connect()
          return client
        },
      })
      wakeEventHubs.push(wakeEvents)
      // LISTEN setup is asynchronous; give it a moment before relying on it
      await wait(300)
      return wakeEvents
    }

    it('notifies on command enqueue and cancellation request', async () => {
      const { runtime } = await createHarness()
      const wakeEvents = await createWakeEvents()

      const commandWoke = new Promise<void>((resolve) => {
        wakeEvents.onCommand('continue', resolve)
      })
      const run = await runtime.store.createRun({
        workflowName: createTestName('postgres-wake-notify'),
        input: {},
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: run.id,
        workflowName: run.workflowName,
      })
      await expect(
        Promise.race([
          commandWoke.then(() => 'woken'),
          wait(3_000).then(() => 'timeout'),
        ]),
      ).resolves.toBe('woken')

      const cancellationWoke = new Promise<void>((resolve) => {
        wakeEvents.onCancellation(run.id, resolve)
      })
      await runtime.store.requestRunCancellation({ runId: run.id })
      await expect(
        Promise.race([
          cancellationWoke.then(() => 'woken'),
          wait(3_000).then(() => 'timeout'),
        ]),
      ).resolves.toBe('woken')
    })

    it('dispatches and completes a run while workers idle on long poll intervals', async () => {
      const harness = await createHarness()
      const wakeEvents = await createWakeEvents()
      const runtime = createPostgresWorkflowRuntime({
        connection: harness.runtime.connection,
        wakeEvents,
      })
      const container = createTestContainer()

      const workflow = defineWorkflow({
        name: createTestName('postgres-wake-dispatch'),
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
        .activity('echo', {
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
        })
        .build()
      const implementation = implementWorkflow(workflow)
        .echo(async (_ctx, input) => input)
        .finish((_ctx, { echo }) => echo)

      const abort = new AbortController()
      const workers = Promise.allSettled([
        runWorkflowWorker({
          ...runtime,
          container,
          workflows: [implementation],
          workerId: 'wake-coordinator',
          idleDelayMs: LONG_DELAY_MS,
          reaping: false,
          runTimeouts: false,
          signal: abort.signal,
        }),
        runExecutionWorker({
          tasks: [],
          ...runtime,
          container,
          workflows: [implementation],
          workerId: 'wake-activity',
          idleDelayMs: LONG_DELAY_MS,
          reaping: false,
          signal: abort.signal,
        }),
      ])

      try {
        // both workers must be inside their idle sleep before the run starts
        await wait(500)
        const client = createWorkflowRuntimeClient(runtime)
        const started = Date.now()
        const run = await client.start(workflow, { text: 'ping' })

        let status = ''
        while (Date.now() - started < 10_000) {
          const snapshot = await client.get(run.id)
          status = snapshot?.run.status ?? ''
          if (status === 'completed') break
          await wait(50)
        }

        expect(status).toBe('completed')
        expect(Date.now() - started).toBeLessThan(LONG_DELAY_MS / 2)
      } finally {
        abort.abort()
        await workers
      }
    })

    it('notifies run changes even with run event history disabled', async () => {
      const { runtime } = await createHarness()
      const wakeEvents = await createWakeEvents()

      const run = await runtime.store.createRun({
        workflowName: createTestName('postgres-wake-notify-only'),
        input: {},
      })
      const runChanged = new Promise<void>((resolve) => {
        wakeEvents.onRunEvent!(run.rootRunId, resolve)
      })
      await runtime.store.markRunRunning({ runId: run.id })

      await expect(
        Promise.race([
          runChanged.then(() => 'woken'),
          wait(3_000).then(() => 'timeout'),
        ]),
      ).resolves.toBe('woken')
    })

    it('watches run status and coarse family changes through LISTEN/NOTIFY', async () => {
      const harness = await createHarness()
      const wakeEvents = await createWakeEvents()
      const runtime = createPostgresWorkflowRuntime({
        connection: harness.runtime.connection,
        wakeEvents,
      })
      const client = createWorkflowRuntimeClient(runtime)
      const run = await runtime.store.createRun({
        workflowName: createTestName('postgres-watch-run-events'),
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'step',
        kind: 'activity',
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'step',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      // a poll interval far above the assertion timeout proves every yield
      // below is NOTIFY-driven
      const iterator = client
        .watch(run.id, { wake: true, pollIntervalMs: LONG_DELAY_MS })
        [Symbol.asyncIterator]()

      try {
        expect((await iterator.next()).value).toStrictEqual({
          kind: 'run',
          status: 'queued',
        })

        // node-level transition: run row untouched, coarse change signal
        const changed = iterator.next()
        await runtime.store.ensureChildAttempt({
          runId: run.id,
          nodeName: 'step',
          childKey: '$self',
          input: {},
        })
        await expect(
          Promise.race([
            changed.then((result) => result.value),
            wait(3_000).then(() => 'timeout'),
          ]),
        ).resolves.toStrictEqual({ kind: 'change' })

        const running = iterator.next()
        await runtime.store.markRunRunning({ runId: run.id })
        await expect(
          Promise.race([
            running.then((result) =>
              result.value && 'status' in result.value
                ? result.value.status
                : undefined,
            ),
            wait(3_000).then(() => 'timeout'),
          ]),
        ).resolves.toBe('running')
      } finally {
        await iterator.return?.()
      }
    })

    it('aborts a running activity on cancel without waiting for the heartbeat cycle', async () => {
      const harness = await createHarness()
      const wakeEvents = await createWakeEvents()
      const runtime = createPostgresWorkflowRuntime({
        connection: harness.runtime.connection,
        wakeEvents,
      })
      const container = createTestContainer()

      const workflow = defineWorkflow({
        name: createTestName('postgres-wake-cancel'),
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
        .activity('hold', {
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
        })
        .build()
      let activityStarted: () => void = () => {}
      const activityRunning = new Promise<void>((resolve) => {
        activityStarted = resolve
      })
      const implementation = implementWorkflow(workflow)
        .hold(async (_ctx, input, lifecycle) => {
          activityStarted()
          await new Promise<never>((_resolve, reject) => {
            lifecycle?.signal.addEventListener(
              'abort',
              () => reject(new Error('activity aborted')),
              { once: true },
            )
          })
          return input
        })
        .finish((_ctx, { hold }) => hold)

      const abort = new AbortController()
      const workers = Promise.allSettled([
        runWorkflowWorker({
          ...runtime,
          container,
          workflows: [implementation],
          workerId: 'cancel-coordinator',
          idleDelayMs: 25,
          reaping: false,
          runTimeouts: false,
          signal: abort.signal,
        }),
        runExecutionWorker({
          tasks: [],
          ...runtime,
          container,
          workflows: [implementation],
          workerId: 'cancel-activity',
          // heartbeat interval = leaseMs / 3; far beyond the asserted latency
          leaseMs: LONG_DELAY_MS * 3,
          idleDelayMs: 25,
          reaping: false,
          signal: abort.signal,
        }),
      ])

      try {
        const client = createWorkflowRuntimeClient(runtime)
        const run = await client.start(workflow, { text: 'hold' })
        await activityRunning

        const cancelledAt = Date.now()
        await client.cancel(run.id)

        let status = ''
        while (Date.now() - cancelledAt < 10_000) {
          const snapshot = await client.get(run.id)
          status = snapshot?.run.status ?? ''
          if (status === 'cancelled') break
          await wait(50)
        }

        expect(status).toBe('cancelled')
        expect(Date.now() - cancelledAt).toBeLessThan(LONG_DELAY_MS / 2)
      } finally {
        abort.abort()
        await workers
      }
    })
  },
)
