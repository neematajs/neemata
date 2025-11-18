// import type { AnyJob } from '@nmtjs/application'
import type { BaseType, t } from '@nmtjs/type'
import type { Redis } from 'ioredis'
// import { ApplicationWorkerType } from '@nmtjs/application'
import { Queue } from 'bullmq'

import type { AnyJob } from '../jobs/job.ts'
import { JobWorkerQueue } from '../enums.ts'

const queueDeploymentLock = 'scheduler-deployment-lock'

export interface JobsSchedulerEntry<T extends AnyJob = AnyJob> {
  job: T
  data: T['_']['input']
  cron: string
}

export type JobsSchedulerOptions = { entries: JobsSchedulerEntry[] }

export class JobsScheduler {
  protected queueConnection: Redis
  queues: Queue[] = []

  constructor(
    protected connection: Redis,
    protected deploymentId: string | undefined,
    protected entries: JobsSchedulerEntry[] = [],
  ) {
    this.queueConnection = connection.duplicate({ lazyConnect: true })
  }

  async initialize() {
    const { connection, deploymentId, entries, queueConnection } = this
    await queueConnection.connect()
    const lock = deploymentId
      ? await connection.set(
          `${queueDeploymentLock}:${deploymentId}`,
          '1',
          'NX',
        )
      : 'OK'
    const isLocked = lock === 'OK'
    const queues = Object.values(JobWorkerQueue)
    for (const queueName of queues) {
      const queue = new Queue(queueName, { connection: queueConnection })
      await queue.waitUntilReady()
      if (isLocked) {
        await queue.pause()
        await queue.drain()
        const schedulers = await queue.getJobSchedulers()
        for (const scheduler of schedulers) {
          await queue.removeJobScheduler(scheduler.id!)
        }
        for (const { cron, data, job } of entries) {
          if (job.options.queue !== queueName) continue
          await queue.add(job.name, data, {
            repeat: { pattern: cron },
            attempts: job.options.attemts,
            backoff: job.options.backoff,
          })
        }
        await queue.resume()
      }

      this.queues.push(queue)
    }
  }
}

export function createSchedulerJobEntry<T extends AnyJob>(
  job: T,
  data: T['_']['input'],
  cron: string,
): JobsSchedulerEntry<T> {
  return { job, data, cron }
}
