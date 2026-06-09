import type { AnyJob, JobsClientInstance } from '@nmtjs/jobs'
import type { Job as BullJob } from 'bullmq'
import { Container } from '@nmtjs/core'
import { createJob, JobManager, QueueJobRunner } from '@nmtjs/jobs'
import { JobSchedulerController } from '@nmtjs/scheduler'
import { Worker } from 'bullmq'
import { afterEach, describe, expect, it } from 'vitest'

import { LifecycleHooks } from '../../../application/src/lifecycle.ts'
import { t } from '../../../type/src/index.ts'
import {
  createTestLogger,
  createTestName,
  requireServiceEnv,
  serviceTargets,
  wait,
} from './helpers.ts'

for (const target of serviceTargets) {
  requireServiceEnv(target)

  describe.skipIf(!target.url)(
    `@nmtjs/scheduler ${target.name} integration`,
    () => {
      const clients: JobsClientInstance[] = []
      const workers: Worker[] = []
      const managers: JobManager[] = []
      const schedulers: JobSchedulerController[] = []

      afterEach(async () => {
        await Promise.allSettled(
          workers.splice(0).map((worker) => worker.close()),
        )
        const activeSchedulers = schedulers.splice(0)
        await Promise.allSettled(
          activeSchedulers.map((scheduler) => scheduler.removeOwned()),
        )
        await Promise.allSettled(
          activeSchedulers.map((scheduler) => scheduler.close()),
        )
        await Promise.allSettled(
          managers.splice(0).map((manager) => manager.terminate()),
        )
        await Promise.allSettled(
          clients.splice(0).map((client) => client.quit()),
        )
      })

      it('schedules jobs through BullMQ job schedulers and removes owned schedules', async () => {
        const job = createJob({
          name: createTestName('integration-scheduled-job'),
          pool: 'default',
          input: t.object({ value: t.string() }),
          output: t.object({ ok: t.boolean(), value: t.string() }),
        }).return(({ input }) => ({ ok: true, value: input.value }))

        const { manager } = await createJobHarness(job)
        const schedulerClient = target.createClient()
        clients.push(schedulerClient)
        const scheduler = new JobSchedulerController({
          owner: createTestName('scheduler'),
          client: schedulerClient,
          jobs: [job],
        })
        schedulers.push(scheduler)
        const scheduleId = createTestName('schedule')
        await scheduler.reconcile([
          {
            id: scheduleId,
            job,
            data: { value: 'scheduled' },
            repeat: { every: 1000, limit: 1 },
            options: { removeOnComplete: false, removeOnFail: false },
          },
        ])

        await expect(scheduler.list(job)).resolves.toEqual([
          expect.objectContaining({
            id: scheduleId,
            schedulerId: expect.stringContaining(scheduleId),
            jobName: job.name,
            queueName: manager.getQueue(job).queue.name,
            data: { value: 'scheduled' },
            every: 1000,
          }),
        ])
        await waitForScheduledResult(manager, job)
        await scheduler.removeOwned()
        await expect(scheduler.list(job)).resolves.toEqual([])
      })

      it('reports updated schedules and removes stale owned schedules during reconcile', async () => {
        const firstJob = createJob({
          name: createTestName('integration-first-scheduled-job'),
          pool: 'default',
          input: t.object({ value: t.string() }),
          output: t.object({ value: t.string() }),
        }).return(({ input }) => input)
        const secondJob = createJob({
          name: createTestName('integration-second-scheduled-job'),
          pool: 'default',
          input: t.object({ value: t.string() }),
          output: t.object({ value: t.string() }),
        }).return(({ input }) => input)
        const schedulerClient = target.createClient()
        clients.push(schedulerClient)
        const scheduler = new JobSchedulerController({
          owner: createTestName('scheduler-reconcile'),
          client: schedulerClient,
          jobs: [firstJob, secondJob],
        })
        schedulers.push(scheduler)
        const firstScheduleId = createTestName('first-schedule')
        const secondScheduleId = createTestName('second-schedule')

        const initial = await scheduler.reconcile([
          {
            id: firstScheduleId,
            job: firstJob,
            data: { value: 'initial' },
            repeat: { every: 1000 },
          },
          {
            id: secondScheduleId,
            job: secondJob,
            data: { value: 'stale' },
            repeat: { every: 2000 },
          },
        ])
        expect(initial).toMatchObject({
          desired: 2,
          removed: 0,
          failedRemovals: 0,
        })
        expect(initial.added + initial.updated + initial.unchanged).toBe(2)

        await expect(
          scheduler.reconcile([
            {
              id: firstScheduleId,
              job: firstJob,
              data: { value: 'updated' },
              repeat: { every: 1500 },
            },
          ]),
        ).resolves.toMatchObject({
          desired: 1,
          added: 0,
          updated: 1,
          unchanged: 0,
          removed: 1,
          failedRemovals: 0,
          scheduledJobs: { desired: 1, previous: 2, updated: 1, removed: 1 },
        })

        await expect(scheduler.list(firstJob)).resolves.toEqual([
          expect.objectContaining({
            id: firstScheduleId,
            data: { value: 'updated' },
            every: 1500,
          }),
        ])
        await expect(scheduler.list(secondJob)).resolves.toEqual([])
      })

      async function createJobHarness(job: AnyJob) {
        const logger = createTestLogger('scheduler-integration')
        const container = new Container({ logger })
        const lifecycleHooks = new LifecycleHooks()
        const managerClient = target.createClient()
        const workerClient = target.createClient()
        clients.push(managerClient, workerClient)
        const manager = new JobManager(managerClient, [job])
        managers.push(manager)
        await manager.initialize()

        const runner = new QueueJobRunner({ logger, container, lifecycleHooks })
        const queue = manager.getQueue(job).queue
        const worker = new Worker(
          queue.name,
          async (bullJob: BullJob) =>
            await runner.runJob(job, bullJob.data, {
              queueJob: bullJob,
              signal: new AbortController().signal,
              result: {},
              stepResults: [],
              currentStepIndex: 0,
              progress: {},
            } as never),
          { connection: workerClient as never },
        )
        workers.push(worker)
        await worker.waitUntilReady()
        return { manager }
      }
    },
  )
}

async function waitForScheduledResult(manager: JobManager, job: AnyJob) {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const list = await manager.list(job, { status: ['completed'], limit: 10 })
    const item = list.items.find(
      (item) =>
        item.data &&
        typeof item.data === 'object' &&
        'value' in item.data &&
        item.data.value === 'scheduled',
    )
    if (item) return
    await wait(50)
  }
  throw new Error('Scheduled job did not complete')
}
