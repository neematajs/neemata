import assert from 'node:assert'
import { randomUUID } from 'node:crypto'

import type {
  Job,
  JobState,
  JobType,
  QueueEventsListener,
  RedisClient,
} from 'bullmq'
import {
  Queue,
  QueueEvents,
  QueueEventsProducer,
  UnrecoverableError,
} from 'bullmq'

import type { ServerStoreConfig } from '../server/config.ts'
import type { Store } from '../types.ts'
import type { AnyJob, JobBackoffOptions } from './job.ts'
import type { JobDefinitionInfo, JobProgressCheckpoint } from './types.ts'
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

export type { JobDefinitionInfo, JobItem, JobStepInfo } from './types.ts'

import type { JobItem, JobStatus } from './types.ts'

/** Job item type with generic job typing for internal use */
export type JobItemOf<T extends AnyJob = AnyJob> = JobItem<
  T['_']['input'],
  T['_']['output']
>

export interface JobManagerInstance {
  list<T extends AnyJob>(
    job: T,
    options?: { page?: number; limit?: number; status?: JobStatus[] },
  ): Promise<{
    items: JobItemOf<T>[]
    page: number
    limit: number
    pages: number
    total: number
  }>
  get<T extends AnyJob>(job: T, id: string): Promise<JobItemOf<T> | null>
  getInfo(job: AnyJob): JobDefinitionInfo
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

/**
 * TODO: Consider implementing an abstract SQL storage layer for job queries.
 *
 * Current limitations with BullMQ direct queries:
 * - Pagination is per-type, requires complex offset calculations
 * - Limited filtering/sorting capabilities
 * - No full-text search on job data
 *
 * Proposed architecture:
 * 1. Shared SQLite file (WAL mode) across all workers on the same machine
 * 2. Each worker subscribes to BullMQ events and syncs to SQLite
 * 3. List/filter/sort queries run against SQLite with proper SQL semantics
 * 4. Mutations (add, retry, cancel, remove) still go through BullMQ directly
 *
 * Benefits:
 * - Proper SQL pagination, filtering, sorting
 * - Abstract storage layer could support different queue backends (not just BullMQ)
 * - No per-process memory duplication (shared file)
 * - Complex queries: date ranges, priority ranges, full-text search
 *
 * Implementation notes:
 * - Use better-sqlite3 (sync, fast for in-memory/WAL)
 * - Subscribe to QueueEvents BEFORE initial sync to buffer events
 * - Handle race conditions: initial load + event replay
 * - Consider leader election for sync to reduce write contention
 */
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
      list: this.list.bind(this),
      add: this.add.bind(this),
      get: this.get.bind(this),
      getInfo: this.getInfo.bind(this),
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

  getInfo(job: AnyJob): JobDefinitionInfo {
    return {
      name: job.options.name,
      steps: job.steps.map((step, index) => ({
        label: step.label,
        conditional: job.conditions.has(index),
      })),
    }
  }

  async list<T extends AnyJob>(
    job: T,
    {
      limit = 20,
      page = 1,
      status = [],
    }: { page?: number; limit?: number; status?: JobStatus[] } = {},
  ) {
    const { queue } = this.getJobQueue(job)
    // Convert vendor-agnostic status to BullMQ JobType for querying
    const bullJobTypes = status.length
      ? status.flatMap((s) => this._mapStatusToJobType(s))
      : []

    // Get counts per type to calculate proper offsets
    const typeCounts = await queue.getJobCounts(...bullJobTypes)
    const jobsCount = Object.values(typeCounts).reduce((a, b) => a + b, 0)
    const totalPages = Math.ceil(jobsCount / limit)
    if (page > totalPages)
      return { items: [], page, limit, pages: totalPages, total: jobsCount }

    // Calculate which types we need to fetch from and with what offsets
    const globalStart = (page - 1) * limit
    const globalEnd = globalStart + limit

    // Determine the ordered types (use bullJobTypes if specified, otherwise use typeCounts keys)
    const orderedTypes =
      bullJobTypes.length > 0
        ? bullJobTypes
        : (Object.keys(typeCounts) as JobType[])

    // Calculate cumulative offsets and fetch jobs from each type as needed
    let cumulative = 0
    const jobPromises: Promise<Job[]>[] = []

    for (const type of orderedTypes) {
      const typeCount = typeCounts[type] ?? 0
      const typeStart = cumulative
      const typeEnd = cumulative + typeCount

      // Check if this type overlaps with our desired range
      if (typeEnd > globalStart && typeStart < globalEnd) {
        // Calculate local start/end within this type
        const localStart = Math.max(0, globalStart - typeStart)
        const localEnd = Math.min(typeCount, globalEnd - typeStart) - 1

        if (localEnd >= localStart) {
          jobPromises.push(queue.getJobs([type], localStart, localEnd))
        }
      }

      cumulative += typeCount
    }

    const jobArrays = await Promise.all(jobPromises)
    const jobs = jobArrays.flat().slice(0, limit)
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

  protected async _mapJob(bullJob: Job): Promise<JobItemOf> {
    const bullState = await bullJob.getState()
    const id = bullJob.id
    assert(typeof id === 'string', 'Expected job id to be a string')

    // Map BullMQ state to vendor-agnostic status
    const status = this._mapStatus(bullState)

    // Extract progress only if it's a valid checkpoint object
    const progress =
      typeof bullJob.progress === 'object' &&
      bullJob.progress !== null &&
      'stepIndex' in bullJob.progress
        ? (bullJob.progress as JobProgressCheckpoint)
        : undefined

    return {
      id,
      name: bullJob.name,
      queue: bullJob.queueName,
      data: bullJob.data,
      output: bullJob.returnvalue,
      status,
      priority: bullJob.priority,
      progress,
      attempts: bullJob.attemptsMade,
      startedAt: bullJob.processedOn,
      completedAt: bullJob.finishedOn,
      error: bullJob.failedReason,
      stacktrace: bullJob.stacktrace,
    }
  }

  /** Map BullMQ JobState to vendor-agnostic JobStatus */
  protected _mapStatus(state: JobState | 'unknown'): JobStatus {
    switch (state) {
      case 'waiting':
      case 'prioritized':
      case 'waiting-children':
        return 'pending'
      case 'active':
        return 'active'
      case 'completed':
        return 'completed'
      case 'failed':
        return 'failed'
      case 'delayed':
        return 'delayed'
      default:
        return 'unknown'
    }
  }

  /** Map vendor-agnostic JobStatus to BullMQ JobType for queries */
  protected _mapStatusToJobType(status: JobStatus): JobType[] {
    switch (status) {
      case 'pending':
        return ['waiting', 'prioritized', 'waiting-children']
      case 'active':
        return ['active']
      case 'completed':
        return ['completed']
      case 'failed':
        return ['failed']
      case 'delayed':
        return ['delayed']
      case 'cancelled':
        return [] // BullMQ doesn't have a cancelled state
      case 'unknown':
      default:
        return []
    }
  }
}
