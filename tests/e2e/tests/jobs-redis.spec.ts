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
import { t } from '@nmtjs/type'
import { Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { afterEach, describe, expect, it } from 'vitest'

import { createTestLogger, createTestName, redisUrl } from './helpers.ts'

const clients: Redis[] = []
const workers: Worker[] = []
const managers: JobManager[] = []

describe.skipIf(!redisUrl)('@nmtjs/jobs Redis e2e', () => {
  afterEach(async () => {
    await Promise.allSettled(workers.splice(0).map((worker) => worker.close()))
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
