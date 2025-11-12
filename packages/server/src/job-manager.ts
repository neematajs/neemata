import type { AnyJob, ApplicationRegistry } from '@nmtjs/application'
import type { AnyInjectable } from '@nmtjs/core'
import type { Job } from 'bullmq'
import type { RedisOptions } from 'ioredis'
import {
  ApplicationWorkerType,
  createApplicationPlugin,
  LifecycleHook,
} from '@nmtjs/application'
import { createLazyInjectable, pick, Scope } from '@nmtjs/core'
import { Queue, QueueEvents } from 'bullmq'
import { Redis } from 'ioredis'

export class QueueJobResult<T extends AnyJob> {
  constructor(
    protected job: T,
    protected bullJob: Job<T['_']['input'], T['_']['output'], T['name']>,
    protected events: QueueEvents,
  ) {}

  async waitResult() {
    return await this.bullJob.waitUntilFinished(this.events)
  }
}

export class JobManagerInstance {
  protected redis: Redis
  protected [ApplicationWorkerType.Io]!: { queue: Queue; events: QueueEvents }
  protected [ApplicationWorkerType.Compute]!: {
    queue: Queue
    events: QueueEvents
  }

  constructor(
    redisOptions: RedisOptions,
    protected registry: ApplicationRegistry,
  ) {
    this.redis = new Redis({ ...redisOptions, lazyConnect: true })
  }

  async initialize() {
    await this.redis.connect()
    for (const queueName of [
      ApplicationWorkerType.Io,
      ApplicationWorkerType.Compute,
    ] as const) {
      this[queueName] = {
        queue: new Queue(queueName, { connection: this.redis }),
        events: new QueueEvents(queueName, {
          connection: this.redis,
          autorun: false,
        }),
      }
    }
    await Promise.all([
      this[ApplicationWorkerType.Io].queue.waitUntilReady(),
      this[ApplicationWorkerType.Io].events.waitUntilReady(),
      this[ApplicationWorkerType.Compute].queue.waitUntilReady(),
      this[ApplicationWorkerType.Compute].events.waitUntilReady(),
    ])
  }

  async terminate() {
    await Promise.allSettled([
      this[ApplicationWorkerType.Io].queue.close(),
      this[ApplicationWorkerType.Io].events.close(),
      this[ApplicationWorkerType.Compute].queue.close(),
      this[ApplicationWorkerType.Compute].events.close(),
    ])
    this.redis.disconnect(false)
  }

  async listAllJobs() {
    const jobs = await Promise.all([
      this[ApplicationWorkerType.Io].queue.getJobs(),
      this[ApplicationWorkerType.Compute].queue.getJobs(),
    ])

    return jobs
      .flat()
      .map((job) =>
        pick(job, {
          id: true,
          queue: job.queueName,
          priority: true,
          progress: true,
          name: true,
          data: true,
          returnvalue: true,
          attemptsMade: true,
          processedOn: true,
          finishedOn: true,
          failedReason: true,
        }),
      )
  }

  async queueJob<T extends AnyJob>(
    job: T,
    data: T['_']['input'],
    options?: { jobId?: string; priority?: number },
  ) {
    const { queue, events } = this[job.options.type]
    const bullJob = await queue.add(job.name as any, data as any, {
      attempts: job.options.attemts,
      backoff: job.options.backoff,
      jobId: options?.jobId,
      priority: options?.priority,
    })
    return new QueueJobResult(job, bullJob, events)
  }
}

export const JobManager = createLazyInjectable<
  JobManagerInstance,
  Scope.Global
>(Scope.Global)

export const JobManagerPlugin = createApplicationPlugin<{
  redisOptions: AnyInjectable<RedisOptions>
}>('JobManager', async ({ container, registry }, options) => {
  const redisOptions = await container.resolve(options.redisOptions)
  const jobManager = new JobManagerInstance(redisOptions, registry)
  container.provide(JobManager, jobManager)
  return {
    hooks: {
      [LifecycleHook.ContainerInitializeBefore]: async () => {
        await jobManager.initialize()
      },
      [LifecycleHook.ContainerDisposeAfter]: async () => {
        await jobManager.terminate()
      },
    },
  }
})
