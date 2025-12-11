import { randomUUID } from 'node:crypto'

import type { Job, JobType, QueueEventsListener, RedisClient } from 'bullmq'
import { createFuture } from '@nmtjs/common'
import { pick } from '@nmtjs/core'
import {
  Queue,
  QueueEvents,
  QueueEventsProducer,
  UnrecoverableError,
} from 'bullmq'

import type { ServerStoreConfig } from '../server/config.ts'
import type { Store } from '../types.ts'
import type { AnyJob, JobBackoffOptions } from './job.ts'
import { JobWorkerQueue } from '../enums.ts'
import { createStoreClient } from '../store/index.ts'

type QueueJobResultOptions<T extends AnyJob = AnyJob> = {
  job: T
  bullJob: Job<T['_']['input'], T['_']['output'], T['name']>
  events: QueueEvents
}

type QueueJobAddOptions = {
  jobId?: string
  priority?: number
  forceMissingWorkers?: boolean
  attempts?: number
  backoff?: JobBackoffOptions
  oneoff?: boolean
  delay?: number
}

export class QueueJobResult<T extends AnyJob = AnyJob> {
  #options: QueueJobResultOptions<T>

  constructor(options: QueueJobResultOptions<T>) {
    this.#options = options
  }

  get id() {
    return this.#options.bullJob.id
  }

  get name() {
    return this.#options.bullJob.name
  }

  async waitResult() {
    return await this.#options.bullJob.waitUntilFinished(this.#options.events)
  }
}

export type JobListItem<T extends AnyJob = AnyJob> = Pick<
  Job<T['_']['input'], T['_']['output'], T['name']>,
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

export interface JobManagerInstance {
  list<T extends AnyJob>(
    job: T,
    options?: { page?: number; limit?: number; state?: JobType[] },
  ): Promise<JobListItem<T>[]>
  get<T extends AnyJob>(job: T, id: string): Promise<JobListItem<T> | null>
  add<T extends AnyJob>(
    job: T,
    data: T['_']['input'],
    options?: QueueJobAddOptions,
  ): Promise<QueueJobResult<T>>
}

export type CustomJobsEvents = QueueEventsListener & {
  [K in `cancel:${string}`]: (args: {}, id: string) => void
}

export class JobManager {
  protected store!: Store
  protected [JobWorkerQueue.Io]!: {
    queue: Queue
    events: QueueEvents
    custom: QueueEventsProducer
  }
  protected [JobWorkerQueue.Compute]!: {
    queue: Queue
    events: QueueEvents
    custom: QueueEventsProducer
  }

  constructor(protected storeConfig: ServerStoreConfig) {}

  get publicInstance(): JobManagerInstance {
    return {
      // @ts-expect-error
      list: this.list.bind(this),
      add: this.add.bind(this),
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
          autorun: true,
        }),
        custom: new QueueEventsProducer(queueName, {
          connection: this.store as RedisClient,
        }),
      }
    }

    await Promise.all([
      this[JobWorkerQueue.Io].queue.waitUntilReady(),
      this[JobWorkerQueue.Io].events.waitUntilReady(),
      this[JobWorkerQueue.Io].custom.waitUntilReady(),
      this[JobWorkerQueue.Compute].queue.waitUntilReady(),
      this[JobWorkerQueue.Compute].events.waitUntilReady(),
      this[JobWorkerQueue.Compute].custom.waitUntilReady(),
    ])
  }

  async terminate() {
    await Promise.allSettled([
      this[JobWorkerQueue.Io].queue.close(),
      this[JobWorkerQueue.Io].events.close(),
      this[JobWorkerQueue.Io].custom.close(),
      this[JobWorkerQueue.Compute].queue.close(),
      this[JobWorkerQueue.Compute].events.close(),
      this[JobWorkerQueue.Compute].custom.close(),
    ])
    this.store.disconnect(false)
  }

  async list<T extends AnyJob>(
    job: T,
    {
      limit = 20,
      page = 1,
      state = [],
    }: { page?: number; limit?: number; state?: JobType[] },
  ) {
    const { queue } = this[job.options.queue]
    const jobsCount = await queue.getJobCountByTypes(...state)
    const totalPages = Math.ceil(jobsCount / limit)
    if (page > totalPages) return []
    const jobs = await queue.getJobs(
      state,
      (page - 1) * limit,
      page * limit - 1,
    )
    return jobs.map((job) => this._mapJob(job))
  }

  async get<T extends AnyJob>(job: T, id: string) {
    const { queue } = this[job.options.queue]
    const bullJob = await queue.getJob(id)
    if (!bullJob) return null
    return this._mapJob(bullJob)
  }

  async add<T extends AnyJob>(
    job: T,
    data: T['_']['input'],
    {
      forceMissingWorkers = false,
      jobId = randomUUID(),
      priority,
      attempts = job.options.attempts,
      backoff = job.options.backoff,
      oneoff = job.options.oneoff ?? true,
      delay,
    }: QueueJobAddOptions = {},
  ) {
    const { queue, events } = this[job.options.queue]

    if (!forceMissingWorkers) {
      if ((await queue.getWorkersCount()) === 0) {
        throw new Error(`No workers available for [${job.options.queue}] queue`)
      }
    }
    const bullJob = await queue.add(job.name as any, data as any, {
      attempts,
      backoff,
      jobId,
      priority,
      delay,
      removeOnComplete: oneoff,
      removeOnFail: oneoff,
    })

    return new QueueJobResult({ job, bullJob, events })
  }

  async cancel(job: AnyJob, id: string) {
    const { custom, queue } = this[job.options.queue]
    const bullJob = await queue.getJob(id)
    if (!bullJob) throw new Error(`Job with id [${id}] not found`)
    if (bullJob.finishedOn) return
    if ((await bullJob.getState()) === 'waiting') {
      return await bullJob.remove()
    }
    if ((await bullJob.getState()) === 'active') {
      await custom.publishEvent({ eventName: `cancel:${id}` })
    }
  }

  cancellationSignal(job: AnyJob, id: string) {
    const { events } = this[job.options.queue]
    const controller = new AbortController()
    const handler = () => {
      controller.abort(new UnrecoverableError('Job cancelled'))
    }
    events.on<CustomJobsEvents>(`cancel:${id}`, handler)
    const signal = controller.signal
    return Object.assign(signal, {
      [Symbol.dispose]: () => {
        events.off<CustomJobsEvents>(`cancel:${id}`, handler)
      },
    })
  }

  getQueue(job: AnyJob) {
    return this[job.options.queue]
  }

  protected async _mapJob(bullJob: Job) {
    return pick(bullJob, {
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
    })
  }
}
