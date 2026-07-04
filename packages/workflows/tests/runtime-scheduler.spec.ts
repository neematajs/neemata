import { PGlite } from '@electric-sql/pglite'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import {
  defineSchedule,
  defineWorkflow,
  implementWorkflow,
} from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runWorkflowWorker,
  type WorkflowRuntimeAdapter,
} from '../src/runtime/index.ts'

type RuntimeFactory = () =>
  | WorkflowRuntimeAdapter
  | Promise<WorkflowRuntimeAdapter>

const createPgliteConnection = () =>
  createPostgresWorkflowConnection(new PGlite())

const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
const testContainer = new Container({ logger })

function schedulerContract(name: string, createRuntime: RuntimeFactory) {
  describe(`${name} workflow scheduler`, () => {
    it('reconciles schedules by inserting, updating, and deleting static declarations', async () => {
      const workflow = defineWorkflow({
        name: `${name}-reconcile-workflow`,
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const alpha = defineSchedule({
        name: `${name}-reconcile-alpha`,
        runnable: workflow,
        input: { scenario: 'alpha' },
        every: '10s',
        tags: { tenant: 'one' },
      })
      const beta = defineSchedule({
        name: `${name}-reconcile-beta`,
        runnable: workflow,
        input: { scenario: 'beta' },
        every: '30s',
      })
      const changedAlpha = defineSchedule({
        name: alpha.name,
        runnable: workflow,
        input: { scenario: 'changed' },
        cron: '*/5 * * * * *',
        tags: { tenant: 'two' },
        enabled: false,
      })
      const runtime = await createRuntime()

      await runtime.scheduler!.reconcile([alpha, beta])
      await runtime.scheduler!.reconcile([changedAlpha])

      await expect(runtime.scheduler!.list()).resolves.toMatchObject([
        {
          name: alpha.name,
          runnableKind: 'workflow',
          runnableName: workflow.name,
          input: { scenario: 'changed' },
          tags: { tenant: 'two' },
          cron: '*/5 * * * * *',
          enabled: false,
        },
      ])
    })

    it('keeps concurrent reconciles in a consistent cutover state', async () => {
      const workflow = defineWorkflow({
        name: `${name}-concurrent-reconcile-workflow`,
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const left = defineSchedule({
        name: `${name}-concurrent-left`,
        runnable: workflow,
        input: { scenario: 'left' },
        every: '1m',
      })
      const right = defineSchedule({
        name: `${name}-concurrent-right`,
        runnable: workflow,
        input: { scenario: 'right' },
        every: '1m',
      })
      const extra = defineSchedule({
        name: `${name}-concurrent-extra`,
        runnable: workflow,
        input: { scenario: 'extra' },
        every: '1m',
      })

      await Promise.all([
        runtime.scheduler!.reconcile([left]),
        runtime.scheduler!.reconcile([right, extra]),
      ])

      const names = (await runtime.scheduler!.list()).map(
        (schedule) => schedule.name,
      )
      expect([
        [`${name}-concurrent-left`],
        [`${name}-concurrent-extra`, `${name}-concurrent-right`],
      ]).toContainEqual(names)
    })

    it('validates schedule input against the runnable schema during reconcile', async () => {
      const workflow = defineWorkflow({
        name: `${name}-invalid-input-workflow`,
        input: t.object({ count: t.number() }),
        output: t.object({ count: t.number() }),
      }).build()
      const runtime = await createRuntime()
      const schedule = defineSchedule({
        name: `${name}-invalid-input-schedule`,
        runnable: workflow,
        input: { count: 'bad' } as never,
        every: '1s',
      })

      await expect(runtime.scheduler!.reconcile([schedule])).rejects.toThrow(
        `${name}-invalid-input-schedule`,
      )
    })

    it('computes every and cron next occurrences from reconcile time', async () => {
      const workflow = defineWorkflow({
        name: `${name}-next-run-workflow`,
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const before = Date.now()

      await runtime.scheduler!.reconcile([
        defineSchedule({
          name: `${name}-every-next`,
          runnable: workflow,
          input: { scenario: 'every' },
          every: '5s',
        }),
        defineSchedule({
          name: `${name}-cron-next`,
          runnable: workflow,
          input: { scenario: 'cron' },
          cron: '*/5 * * * * *',
        }),
      ])

      const schedules = await runtime.scheduler!.list()
      const every = schedules.find((item) => item.name.endsWith('every-next'))
      const cron = schedules.find((item) => item.name.endsWith('cron-next'))

      expect(every?.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 4_000)
      expect(every?.nextRunAt.getTime()).toBeLessThanOrEqual(before + 6_000)
      expect(cron?.nextRunAt.getTime()).toBeGreaterThan(before)
      expect(cron?.nextRunAt.getTime()).toBeLessThanOrEqual(before + 5_000)
    })

    it('fires due schedules once per slot and advances past now while skipping missed slots', async () => {
      const workflow = defineWorkflow({
        name: `${name}-fire-workflow`,
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const schedule = defineSchedule({
        name: `${name}-fire-schedule`,
        runnable: workflow,
        input: { scenario: 'alpha' },
        every: '10ms',
        tags: { tenant: 'tenant-1' },
        immediately: true,
      })

      await runtime.scheduler!.reconcile([schedule])
      const [beforeFire] = await runtime.scheduler!.list()
      const now = new Date(beforeFire!.nextRunAt.getTime() + 1_000)

      await expect(
        runtime.scheduler!.fireDue({ now, limit: 10 }),
      ).resolves.toStrictEqual({ fired: 1 })
      await expect(
        runtime.scheduler!.fireDue({ now, limit: 10 }),
      ).resolves.toStrictEqual({ fired: 0 })

      const runs = await client.list({ tags: { schedule: schedule.name } })
      const [afterFire] = await runtime.scheduler!.list()
      expect(runs.runs).toHaveLength(1)
      expect(runs.runs[0]).toMatchObject({
        kind: 'workflow',
        name: workflow.name,
        input: { scenario: 'alpha' },
        tags: { tenant: 'tenant-1', schedule: schedule.name },
        idempotencyKey: [
          '$schedule',
          schedule.name,
          beforeFire!.nextRunAt.toISOString(),
        ],
      })
      expect(afterFire!.lastSlotAt?.toISOString()).toBe(
        beforeFire!.nextRunAt.toISOString(),
      )
      expect(afterFire!.nextRunAt.getTime()).toBeGreaterThan(now.getTime())
    })

    it('does not fire disabled schedules', async () => {
      const workflow = defineWorkflow({
        name: `${name}-disabled-workflow`,
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      await runtime.scheduler!.reconcile([
        defineSchedule({
          name: `${name}-disabled-schedule`,
          runnable: workflow,
          input: { scenario: 'alpha' },
          every: '1s',
          enabled: false,
          immediately: true,
        }),
      ])

      await expect(
        runtime.scheduler!.fireDue({ now: new Date(Date.now() + 10_000) }),
      ).resolves.toStrictEqual({ fired: 0 })
      await expect(client.list()).resolves.toStrictEqual({ runs: [] })
    })

    it('supports client list, trigger, and setEnabled schedule operations', async () => {
      const workflow = defineWorkflow({
        name: `${name}-client-schedule-workflow`,
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const schedule = defineSchedule({
        name: `${name}-client-schedule`,
        runnable: workflow,
        input: { scenario: 'alpha' },
        every: '1h',
      })
      await runtime.scheduler!.reconcile([schedule])

      await expect(client.schedules.list()).resolves.toMatchObject([
        { name: schedule.name, enabled: true },
      ])
      await expect(
        client.schedules.setEnabled(schedule.name, false),
      ).resolves.toMatchObject({ name: schedule.name, enabled: false })
      await expect(
        client.schedules.setEnabled(schedule.name, true),
      ).resolves.toMatchObject({ name: schedule.name, enabled: true })

      const first = await client.schedules.trigger(schedule.name)
      const second = await client.schedules.trigger(schedule.name)

      expect(second.id).not.toBe(first.id)
      await expect(
        client.list({ tags: { schedule: schedule.name } }),
      ).resolves.toMatchObject({ runs: [{ id: second.id }, { id: first.id }] })
    })
  })
}

describe('schedule definitions', () => {
  const workflow = defineWorkflow({
    name: 'definition-schedule-workflow',
    input: t.object({ scenario: t.string() }),
    output: t.object({ caseId: t.string() }),
  }).build()

  it('requires exactly one cadence', () => {
    expect(() =>
      defineSchedule({
        name: 'missing-cadence',
        runnable: workflow,
        input: { scenario: 'alpha' },
      }),
    ).toThrow('exactly one')
    expect(() =>
      defineSchedule({
        name: 'duplicate-cadence',
        runnable: workflow,
        input: { scenario: 'alpha' },
        every: '1s',
        cron: '* * * * *',
      }),
    ).toThrow('exactly one')
  })

  it('validates cadence syntax', () => {
    expect(() =>
      defineSchedule({
        name: 'invalid-every-schedule',
        runnable: workflow,
        input: { scenario: 'alpha' },
        every: 'soon' as never,
      }),
    ).toThrow('invalid-every-schedule')
    expect(() =>
      defineSchedule({
        name: 'invalid-cron-schedule',
        runnable: workflow,
        input: { scenario: 'alpha' },
        cron: 'not cron',
      }),
    ).toThrow('invalid-cron-schedule')
  })
})

describe('scheduled workflow worker loop', () => {
  it('fires due schedules while normal command processing continues', async () => {
    const workflow = defineWorkflow({
      name: 'worker-scheduled-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    await runtime.scheduler.reconcile([
      defineSchedule({
        name: 'worker-schedule',
        runnable: workflow,
        input: { scenario: 'alpha' },
        every: '1h',
        immediately: true,
      }),
    ])

    const result = await runWorkflowWorker({
      ...runtime,
      container: testContainer,
      workflows: [implementation],
      workerId: 'scheduled-worker-1',
      scheduling: { everyMs: 0, batchSize: 10 },
      maxIdleClaims: 3,
    })

    const runs = await client.list({ tags: { schedule: 'worker-schedule' } })
    expect(result.processed).toBe(1)
    expect(runs.runs[0]?.status).toBe('completed')
  })
})

schedulerContract('in-memory', createInMemoryWorkflowRuntime)
schedulerContract('postgres', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  return createPostgresWorkflowRuntime({ connection })
})
