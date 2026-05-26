import assert from 'node:assert'
import { randomUUID } from 'node:crypto'

import type { LifecycleHooks } from '@nmtjs/application'
import type { Container, Logger } from '@nmtjs/core'
import type {
  Job,
  JobSchedulerJson,
  JobState,
  JobType,
  QueueEventsListener,
  RedisClient,
  RepeatOptions,
} from 'bullmq'
import {
  Queue,
  QueueEvents,
  QueueEventsProducer,
  UnrecoverableError,
} from 'bullmq'

import type { JobsClientInstance } from './client.ts'
import type { JobsHookErrorHandler, JobsLifecycleHooks } from './core/hooks.ts'
import type { AnyJob } from './core/job.ts'
import type { JobAddOptions, JobItemOf, JobsManager } from './core/queue.ts'
import type {
  JobRunnerRunAfterStepParams,
  JobRunnerRunOptions,
  SaveProgressContext,
} from './core/runner.ts'
import type { JobScheduleEntry, JobScheduleInfo } from './core/scheduler.ts'
import type {
  JobDefinitionInfo,
  JobExecutionContext,
  JobProgressCheckpoint,
  JobStatus,
} from './core/types.ts'
import { callJobsHook } from './core/hooks.ts'
import { JobRunner } from './core/runner.ts'

export class QueueJobRunner extends JobRunner<
  JobRunnerRunOptions & { queueJob: Job }
> {
  constructor(
    protected runtime: {
      logger: Logger
      container: Container
      lifecycleHooks: LifecycleHooks
    },
  ) {
    super(runtime)
  }

  protected createJobInfo(
    job: AnyJob,
    options: Partial<JobRunnerRunOptions & { queueJob: Job }>,
  ): JobExecutionContext {
    const { queueJob } = options
    return {
      name: job.options.name,
      id: queueJob?.id,
      queue: queueJob?.queueName,
      attempts: queueJob?.attemptsMade,
      stepIndex: options.stepResults
        ? this.nextStepIndex(options.stepResults)
        : options.currentStepIndex,
    }
  }

  protected createSaveProgressFn(
    context: SaveProgressContext<JobRunnerRunOptions & { queueJob: Job }>,
  ): () => Promise<void> {
    return async () => {
      const { job, progress, result, stepResults, options } = context
      if (!options || !stepResults) return

      const currentStepIndex = this.nextStepIndex(stepResults)
      const checkpoint = createCheckpoint({
        job,
        currentStepIndex,
        result,
        stepResults,
        progress,
      })

      await options.queueJob.updateProgress(checkpoint)
    }
  }

  protected async afterStep(
    params: JobRunnerRunAfterStepParams<
      JobRunnerRunOptions & { queueJob: Job }
    >,
  ): Promise<void> {
    await super.afterStep(params)
    const {
      job,
      step,
      result,
      stepResult,
      stepResults,
      stepIndex,
      options: { queueJob, progress },
    } = params
    const currentStepIndex = this.nextStepIndex(stepResults)
    const checkpoint = createCheckpoint({
      job,
      currentStepIndex,
      result,
      stepResults,
      progress,
    })

    await Promise.all([
      queueJob.log(
        `Step ${step.label || stepIndex + 1} completed in ${(stepResult.duration / 1000).toFixed(3)}s`,
      ),
      queueJob.updateProgress(checkpoint),
    ])
  }
}

function createCheckpoint(options: {
  job: AnyJob
  currentStepIndex: number
  result: Record<string, unknown>
  stepResults: JobProgressCheckpoint['stepResults']
  progress: Record<string, unknown>
}): JobProgressCheckpoint {
  const { job, currentStepIndex, result, stepResults, progress } = options
  const encodedProgress = job.progress
    ? job.progress.encode(progress)
    : progress

  return {
    stepIndex: currentStepIndex,
    stepLabel: job.jobSteps[currentStepIndex]?.label,
    result,
    stepResults,
    progress: encodedProgress,
  }
}
/**
 * Get the dedicated queue name for a job.
 */
export function getJobQueueName(job: AnyJob): string {
  return `job.${job.options.name}`
}

type QueueJobResultOptions<T extends AnyJob = AnyJob> = {
  job: T
  bullJob: Job<T['_']['input'], T['_']['output'], T['options']['name']>
  events: QueueEvents
}

export class QueueJobResult<T extends AnyJob = AnyJob> {
  #options: QueueJobResultOptions<T>

  constructor(options: QueueJobResultOptions<T>) {
    this.#options = options
  }

  get id() {
    return this.#options.bullJob.id!
  }

  get name() {
    return this.#options.job.options.name
  }

  async waitResult() {
    return await this.#options.bullJob.waitUntilFinished(this.#options.events)
  }
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
  protected client: RedisClient
  /**
   * Per-job dedicated queues. Each job has its own queue for granular control.
   */
  protected jobQueues = new Map<string, JobQueueEntry>()

  constructor(
    client: JobsClientInstance,
    public readonly jobs: AnyJob[],
    private readonly hooks: JobsLifecycleHooks = {},
    private readonly onHookError?: JobsHookErrorHandler,
  ) {
    this.client = client as unknown as RedisClient
  }

  get connection(): RedisClient {
    return this.client
  }

  get publicInstance(): JobsManager {
    return {
      list: this.list.bind(this),
      add: this.add.bind(this),
      get: this.get.bind(this),
      getInfo: this.getInfo.bind(this),
      retry: this.retry.bind(this),
      remove: this.remove.bind(this),
      cancel: this.cancel.bind(this),
      schedule: this.schedule.bind(this),
      unschedule: this.unschedule.bind(this),
      listSchedules: this.listSchedules.bind(this),
    }
  }

  async initialize() {
    for (const job of this.jobs) {
      const queueName = getJobQueueName(job)
      const entry: JobQueueEntry = {
        queue: new Queue(queueName, { connection: this.client }),
        events: new QueueEvents(queueName, {
          connection: this.client,
          autorun: true,
        }),
        custom: new QueueEventsProducer(queueName, { connection: this.client }),
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
      steps: job.jobSteps.map((step, index) => ({
        label: step.label,
        conditional: job.conditions.has(index),
        parallel: job.parallelGroupByStepIndex.has(index),
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
    // Convert public status to queue job type for querying.
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
    }: JobAddOptions = {},
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

    await this.emitAdded(bullJob)
    return new QueueJobResult({ job, bullJob, events })
  }

  async schedule<T extends AnyJob>(entry: JobScheduleEntry<T>) {
    const { queue, events } = this.getJobQueue(entry.job)
    const bullJob = await queue.upsertJobScheduler(
      entry.id,
      toBullRepeatOptions(entry.repeat),
      {
        name: entry.job.options.name,
        data: entry.data,
        opts: {
          priority: entry.options?.priority,
          attempts: entry.options?.attempts ?? entry.job.options.attempts,
          backoff: entry.options?.backoff ?? entry.job.options.backoff,
          removeOnComplete:
            entry.options?.removeOnComplete ?? entry.job.options.oneoff ?? true,
          removeOnFail:
            entry.options?.removeOnFail ?? entry.job.options.oneoff ?? true,
        },
      },
    )

    await this.emitAdded(bullJob)
    return new QueueJobResult({ job: entry.job, bullJob, events })
  }

  async unschedule(job: AnyJob, id: string) {
    const { queue } = this.getJobQueue(job)
    const removed = await queue.removeJobScheduler(id)
    if (!removed) throw new Error(`Job scheduler [${id}] not found`)
  }

  async listSchedules<T extends AnyJob>(
    job: T,
  ): Promise<JobScheduleInfo<T['_']['input']>[]> {
    const { queue } = this.getJobQueue(job)
    const schedules = (await queue.getJobSchedulers()) as JobSchedulerJson<
      T['_']['input']
    >[]
    return schedules.map((schedule) => mapJobSchedule(queue.name, schedule))
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
    await this.emitUpdated(bullJob)
  }

  async remove(job: AnyJob, id: string) {
    const { queue } = this.getJobQueue(job)
    const bullJob = await queue.getJob(id)
    if (!bullJob) throw new Error(`Job with id [${id}] not found`)
    await bullJob.remove()
    await callJobsHook(
      this.hooks,
      'removed',
      { id, jobName: job.name, queueName: queue.name, removedAt: Date.now() },
      this.onHookError,
    )
  }

  async cancel(job: AnyJob, id: string) {
    const { custom, queue } = this.getJobQueue(job)
    const bullJob = await queue.getJob(id)
    if (!bullJob) throw new Error(`Job with id [${id}] not found`)
    if (bullJob.finishedOn) return
    if ((await bullJob.getState()) === 'waiting') {
      await bullJob.remove()
      await callJobsHook(
        this.hooks,
        'removed',
        { id, jobName: job.name, queueName: queue.name, removedAt: Date.now() },
        this.onHookError,
      )
      return
    }
    if ((await bullJob.getState()) === 'active') {
      await custom.publishEvent({ eventName: `cancel:${id}` })
      await this.emitUpdated(bullJob, 'cancelled')
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

    // Map queue state to public status.
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

  async emitUpdated(bullJob: Job, overrideStatus?: JobStatus): Promise<void> {
    const item = await this._mapJob(bullJob)
    await callJobsHook(
      this.hooks,
      'updated',
      {
        id: item.id,
        jobName: item.name,
        queueName: item.queue,
        status: overrideStatus ?? item.status,
        attempt: item.attempts,
        input: item.data,
        output: item.output,
        checkpoint: item.progress,
        error: item.error,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        updatedAt: Date.now(),
      },
      this.onHookError,
    )
  }

  private async emitAdded(bullJob: Job): Promise<void> {
    const item = await this._mapJob(bullJob)
    await callJobsHook(
      this.hooks,
      'added',
      {
        id: item.id,
        jobName: item.name,
        queueName: item.queue,
        status: item.status,
        attempt: item.attempts,
        input: item.data,
        output: item.output,
        checkpoint: item.progress,
        error: item.error,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      this.onHookError,
    )
  }

  /** Map queue job state to public job status. */
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

  /** Map public job status to queue job types. */
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
        return [] // Queue does not have a cancelled state.
      default:
        return []
    }
  }
}

function toBullRepeatOptions(
  repeat: JobScheduleEntry['repeat'],
): Omit<RepeatOptions, 'key'> {
  return {
    pattern: 'cron' in repeat ? repeat.cron : undefined,
    every: 'every' in repeat ? repeat.every : undefined,
    limit: repeat.limit,
    immediately: repeat.immediately,
    tz: repeat.timezone,
  }
}

function mapJobSchedule<TData>(
  queueName: string,
  schedule: JobSchedulerJson<TData>,
): JobScheduleInfo<TData> {
  return {
    id: schedule.key,
    jobName: schedule.name,
    queueName,
    data: schedule.template?.data,
    next: schedule.next,
    every: schedule.every,
    cron: schedule.pattern,
    timezone: schedule.tz,
  }
}
