import type { AnyJob } from '@nmtjs/jobs'
import type { Job as BullJob } from 'bullmq'
import { LifecycleHooks } from '@nmtjs/application'
import { Container } from '@nmtjs/core'
import {
  createJob,
  createStep,
  JobManager,
  QueueJobRunner,
  saveJobProgress,
} from '@nmtjs/jobs'
import { JobSchedulerController } from '@nmtjs/scheduler'
import { t } from '@nmtjs/type'
import { Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { afterEach, describe, expect, it } from 'vitest'

import { createTestLogger, createTestName, redisUrl } from './helpers.ts'

const clients: Redis[] = []
const workers: Worker[] = []
const managers: JobManager[] = []
const schedulers: JobSchedulerController[] = []

describe.skipIf(!redisUrl)('@nmtjs/jobs Redis e2e', () => {
  afterEach(async () => {
    await Promise.allSettled(workers.splice(0).map((worker) => worker.close()))
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
    await Promise.allSettled(clients.splice(0).map((client) => client.quit()))
  })

  it('adds and processes a job through BullMQ and JobManager', async () => {
    const job = createJob({
      name: createTestName('e2e-job'),
      pool: 'default',
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean(), value: t.string() }),
    }).return(({ input }) => ({ ok: true, value: input.value }))

    const logger = createTestLogger('jobs-e2e')
    const container = new Container({ logger })
    const lifecycleHooks = new LifecycleHooks()
    const managerClient = createRedisClient()
    const workerClient = createRedisClient()
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
      { connection: workerClient },
    )
    workers.push(worker)
    await worker.waitUntilReady()

    const result = await manager.add(job, { value: 'redis' }, { oneoff: false })

    await expect(result.waitResult()).resolves.toEqual({
      ok: true,
      value: 'redis',
    })
    await expect(manager.get(job, result.id)).resolves.toMatchObject({
      id: result.id,
      status: 'completed',
      output: { ok: true, value: 'redis' },
    })
    await manager.remove(job, result.id)
    await expect(manager.get(job, result.id)).resolves.toBeNull()
  })

  it('retries failed jobs through Redis-backed BullMQ attempts', async () => {
    let attempts = 0
    const job = createJob({
      name: createTestName('e2e-retry-job'),
      pool: 'default',
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean(), value: t.string() }),
      attempts: 2,
      backoff: { type: 'fixed', delay: 10 },
    }).return(({ input }) => {
      attempts++
      if (attempts === 1) throw new Error('retry me')
      return { ok: true, value: input.value }
    })

    const { manager } = await createJobHarness(job)
    const result = await manager.add(
      job,
      { value: 'retried' },
      { oneoff: false },
    )

    await expect(result.waitResult()).resolves.toEqual({
      ok: true,
      value: 'retried',
    })
    expect(attempts).toBe(2)
    await expect(manager.get(job, result.id)).resolves.toMatchObject({
      status: 'completed',
      output: { ok: true, value: 'retried' },
    })
  })

  it('persists job progress checkpoints in Redis', async () => {
    const step = createStep({
      label: 'save progress',
      input: t.object({ value: t.string() }),
      output: t.object({ processed: t.string() }),
      dependencies: { save: saveJobProgress },
      async handler(ctx, input, progress: Record<string, unknown>) {
        progress.saved = input.value
        await ctx.save()
        return { processed: input.value }
      },
    })
    const job = createJob({
      name: createTestName('e2e-progress-job'),
      pool: 'default',
      input: t.object({ value: t.string() }),
      output: t.object({ processed: t.string() }),
      data: (_ctx, _input, progress) => progress,
    })
      .step(step)
      .return(({ data }) => ({ processed: data.saved as string }))

    const { manager } = await createJobHarness(job)
    const result = await manager.add(
      job,
      { value: 'checkpoint' },
      { oneoff: false },
    )

    await expect(result.waitResult()).resolves.toEqual({
      processed: 'checkpoint',
    })
    await expect(manager.get(job, result.id)).resolves.toMatchObject({
      status: 'completed',
      progress: { stepIndex: 1, progress: { saved: 'checkpoint' } },
    })
  })

  it('schedules jobs through @nmtjs/scheduler and BullMQ job schedulers', async () => {
    const job = createJob({
      name: createTestName('e2e-scheduled-job'),
      pool: 'default',
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean(), value: t.string() }),
    }).return(({ input }) => ({ ok: true, value: input.value }))

    const { manager } = await createJobHarness(job)
    const schedulerClient = createRedisClient()
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
})

function createRedisClient() {
  return new Redis(redisUrl!, { maxRetriesPerRequest: null })
}

async function createJobHarness(job: AnyJob) {
  const logger = createTestLogger('jobs-e2e')
  const container = new Container({ logger })
  const lifecycleHooks = new LifecycleHooks()
  const managerClient = createRedisClient()
  const workerClient = createRedisClient()
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
    { connection: workerClient },
  )
  workers.push(worker)
  await worker.waitUntilReady()
  return { manager }
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
