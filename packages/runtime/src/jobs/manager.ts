import type { Job, RedisClient } from 'bullmq'
import { pick } from '@nmtjs/core'
import { Queue, QueueEvents } from 'bullmq'

import type { ServerStoreConfig } from '../server/config.ts'
import type { Store } from '../types.ts'
import type { AnyJob } from './job.ts'
import { JobWorkerQueue } from '../enums.ts'
import { createStoreClient } from '../store/index.ts'

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

export interface JobManagerInstance {
  listAllJobs(): Promise<
    Array<
      Pick<
        Job,
        | 'id'
        | 'queueName'
        | 'priority'
        | 'progress'
        | 'name'
        | 'data'
        | 'returnvalue'
        | 'attemptsMade'
        | 'processedOn'
        | 'finishedOn'
        | 'failedReason'
      >
    >
  >
  queueJob<T extends AnyJob>(
    job: T,
    data: T['_']['input'],
    options?: { jobId?: string; priority?: number },
  ): Promise<QueueJobResult<T>>
}

export class JobManager {
  protected store!: Store
  protected [JobWorkerQueue.Io]!: { queue: Queue; events: QueueEvents }
  protected [JobWorkerQueue.Compute]!: { queue: Queue; events: QueueEvents }

  constructor(protected storeConfig: ServerStoreConfig) {}

  get publicInstance(): JobManagerInstance {
    return {
      listAllJobs: this.listAllJobs.bind(this),
      queueJob: this.queueJob.bind(this),
    }
  }

  async initialize() {
    this.store = await createStoreClient(this.storeConfig)
    await this.store.connect()

    for (const queueName of [
      JobWorkerQueue.Io,
      JobWorkerQueue.Compute,
    ] as const) {
      this[queueName] = {
        queue: new Queue(queueName, { connection: this.store as RedisClient }),
        events: new QueueEvents(queueName, {
          connection: this.store as RedisClient,
          autorun: false,
        }),
      }
    }
    await Promise.all([
      this[JobWorkerQueue.Io].queue.waitUntilReady(),
      this[JobWorkerQueue.Io].events.waitUntilReady(),
      this[JobWorkerQueue.Compute].queue.waitUntilReady(),
      this[JobWorkerQueue.Compute].events.waitUntilReady(),
    ])
  }

  async terminate() {
    await Promise.allSettled([
      this[JobWorkerQueue.Io].queue.close(),
      this[JobWorkerQueue.Io].events.close(),
      this[JobWorkerQueue.Compute].queue.close(),
      this[JobWorkerQueue.Compute].events.close(),
    ])
    this.store.disconnect(false)
  }

  async listAllJobs() {
    const jobs = await Promise.all([
      this[JobWorkerQueue.Io].queue.getJobs(),
      this[JobWorkerQueue.Compute].queue.getJobs(),
    ])

    return jobs
      .flat()
      .map((job) =>
        pick(job, {
          id: true,
          queueName: true,
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
    const { queue, events } = this[job.options.queue]
    const bullJob = await queue.add(job.name as any, data as any, {
      attempts: job.options.attemts,
      backoff: job.options.backoff,
      jobId: options?.jobId,
      priority: options?.priority,
    })
    return new QueueJobResult(job, bullJob, events)
  }
}
