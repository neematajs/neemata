import assert from 'node:assert'
import { randomUUID } from 'node:crypto'

import type {
  Job,
  JobState,
  JobType,
  QueueEventsListener,
  RedisClient,
} from 'bullmq'
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
import { createStoreClient } from '../store/index.ts'

/**
 * Get the dedicated BullMQ queue name for a job
 */
export function getJobQueueName(job: AnyJob): string {
  return `job.${job.options.name}`
}

type QueueJobResultOptions<T extends AnyJob = AnyJob> = {
  job: T
  bullJob: Job<T['_']['input'], T['_']['output'], T['options']['name']>
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
    return this.#options.job.options.name
  }

  async waitResult() {
    return await this.#options.bullJob.waitUntilFinished(this.#options.events)
  }
}

export type JobItem<T extends AnyJob = AnyJob> = Pick<
  Job<T['_']['input'], T['_']['output'], T['options']['name']>,
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
  | 'stacktrace'
> & { id: string; status: JobState | 'unknown' }

export interface JobManagerInstance {
  list<T extends AnyJob>(
    job: T,
    options?: { page?: number; limit?: number; state?: JobState[] },
  ): Promise<{
    items: JobItem<T>[]
    page: number
    limit: number
    pages: number
    total: number
  }>
  get<T extends AnyJob>(job: T, id: string): Promise<JobItem<T> | null>
  add<T extends AnyJob>(
    job: T,
    data: T['_']['input'],
    options?: QueueJobAddOptions,
  ): Promise<QueueJobResult<T>>
  retry(
    job: AnyJob,
    id: string,
    options?: { clearState?: boolean },
  ): Promise<void>
  remove(job: AnyJob, id: string): Promise<void>
  cancel(job: AnyJob, id: string): Promise<void>
}

export type CustomJobsEvents = QueueEventsListener & {
  [K in `cancel:${string}`]: (args: {}, id: string) => void
}

type JobQueueEntry = {
  queue: Queue
  events: QueueEvents
  custom: QueueEventsProducer
}

export class JobManager {
  protected store!: Store
  /**
   * Per-job dedicated queues. Each job has its own queue for granular control.
   */
  protected jobQueues = new Map<string, JobQueueEntry>()

  constructor(
    protected storeConfig: ServerStoreConfig,
    protected jobs: AnyJob[],
  ) {}

  get publicInstance(): JobManagerInstance {
    return {
      // @ts-expect-error
      list: this.list.bind(this),
      add: this.add.bind(this),
      get: this.get.bind(this),
      retry: this.retry.bind(this),
      remove: this.remove.bind(this),
      cancel: this.cancel.bind(this),
    }
  }

  async initialize() {
    this.store = await createStoreClient(this.storeConfig)
    await this.store.connect()

    // Create a dedicated queue for each job
    for (const job of this.jobs) {
      const queueName = getJobQueueName(job)
      const entry: JobQueueEntry = {
        queue: new Queue(queueName, { connection: this.store as RedisClient }),
        events: new QueueEvents(queueName, {
          connection: this.store as RedisClient,
          autorun: true,
        }),
        custom: new QueueEventsProducer(queueName, {
          connection: this.store as RedisClient,
        }),
      }
      this.jobQueues.set(job.options.name, entry)
    }

    // Wait for all queues to be ready
    await Promise.all(
      Array.from(this.jobQueues.values()).flatMap((entry) => [
        entry.queue.waitUntilReady(),
        entry.events.waitUntilReady(),
        entry.custom.waitUntilReady(),
      ]),
    )
  }

  async terminate() {
    await Promise.allSettled(
      Array.from(this.jobQueues.values()).flatMap((entry) => [
        entry.queue.close(),
        entry.events.close(),
        entry.custom.close(),
      ]),
    )
    this.store.disconnect(false)
  }

  protected getJobQueue(job: AnyJob): JobQueueEntry {
    const entry = this.jobQueues.get(job.options.name)
    if (!entry) {
      throw new Error(`Job queue for [${job.options.name}] not found`)
    }
    return entry
  }

  async list<T extends AnyJob>(
    job: T,
    {
      limit = 20,
      page = 1,
      state = [],
    }: { page?: number; limit?: number; state?: JobType[] },
  ) {
    const { queue } = this.getJobQueue(job)
    const jobsCount = await queue.getJobCountByTypes(...state)
    const totalPages = Math.ceil(jobsCount / limit)
    if (page > totalPages) return []
    const jobs = await queue.getJobs(
      state,
      (page - 1) * limit,
      page * limit - 1,
    )
    const items = await Promise.all(jobs.map((job) => this._mapJob(job)))
    return { items, page, limit, pages: totalPages, total: jobsCount }
  }

  async get<T extends AnyJob>(job: T, id: string) {
    const { queue } = this.getJobQueue(job)
    const bullJob = await queue.getJob(id)
    if (!bullJob) return null
    return await this._mapJob(bullJob)
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
    const { queue, events } = this.getJobQueue(job)

    if (!forceMissingWorkers) {
      if ((await queue.getWorkersCount()) === 0) {
        throw new Error(
          `No workers available for [${getJobQueueName(job)}] queue`,
        )
      }
    }
    const bullJob = await queue.add(job.options.name as any, data as any, {
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

  async retry(job: AnyJob, id: string, options?: { clearState?: boolean }) {
    const { queue } = this.getJobQueue(job)
    const bullJob = await queue.getJob(id)
    if (!bullJob) throw new Error(`Job with id [${id}] not found`)

    const state = await bullJob.getState()
    // For completed jobs, clear state by default so it reruns from scratch
    // For failed jobs, keep state by default so it resumes from checkpoint
    const shouldClearState = options?.clearState ?? state === 'completed'

    if (shouldClearState) {
      await bullJob.updateProgress({})
    }

    await bullJob.retry()
  }

  async remove(job: AnyJob, id: string) {
    const { queue } = this.getJobQueue(job)
    const bullJob = await queue.getJob(id)
    if (!bullJob) throw new Error(`Job with id [${id}] not found`)
    await bullJob.remove()
  }

  async cancel(job: AnyJob, id: string) {
    const { custom, queue } = this.getJobQueue(job)
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
    const { events } = this.getJobQueue(job)
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
    return this.getJobQueue(job)
  }

  protected async _mapJob(bullJob: Job): Promise<JobItem> {
    const status = await bullJob.getState()
    const id = bullJob.id
    assert(typeof id === 'string', 'Expected job id to be a string')
    return {
      ...pick(bullJob, {
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
        stacktrace: true,
      }),
      id,
      status,
    }
  }
}
