import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'
import type {
  AnyJob,
  JobBackoffOptions,
  JobsClient,
  JobsClientInstance,
} from '@nmtjs/jobs'
import type { JobSchedulerJson, RedisClient, RepeatOptions } from 'bullmq'
import { getJobQueueName } from '@nmtjs/jobs'
import { Queue } from 'bullmq'

export type SchedulerJobsFactory<Job extends AnyJob = AnyJob> =
  () => MaybePromise<readonly Job[]>

export type SchedulerSchedulesFactory<Job extends AnyJob = AnyJob> =
  () => MaybePromise<readonly JobScheduleEntry<Job>[]>

export type SchedulerHandoffPolicy = 'continuity' | 'cutover'

export type SchedulerConfig<Job extends AnyJob = AnyJob> = {
  client: JobsClient
  jobs: SchedulerJobsFactory<Job>
  schedules: SchedulerSchedulesFactory<Job>
  handoff?: SchedulerHandoffPolicy
}

export type ResolvedSchedulerConfig<Job extends AnyJob = AnyJob> = {
  client: JobsClient
  jobs: readonly Job[]
  schedules: readonly JobScheduleEntry<Job>[]
  handoff: SchedulerHandoffPolicy
}

type JobScheduleRepeatBase = {
  limit?: number
  immediately?: boolean
  timezone?: string
}

export type JobScheduleCron = JobScheduleRepeatBase & {
  cron: string
  every?: never
}

export type JobScheduleEvery = JobScheduleRepeatBase & {
  every: number
  cron?: never
}

export type JobScheduleRepeat = JobScheduleCron | JobScheduleEvery

export type JobScheduleOptions = {
  priority?: number
  attempts?: number
  backoff?: JobBackoffOptions
  removeOnComplete?: boolean | number
  removeOnFail?: boolean | number
}

export type JobScheduleEntry<T extends AnyJob = AnyJob> = {
  id: string
  job: T
  data: T['_']['input']
  repeat: JobScheduleRepeat
  options?: JobScheduleOptions
}

export type JobScheduleInfo<TData = unknown> = {
  id: string
  schedulerId: string
  jobName?: string
  queueName: string
  data?: TData
  next?: number
  every?: number
  cron?: string
  timezone?: string
}

type OwnedSchedule = { queueName: string; schedulerId: string }

type SchedulerLogObject = Record<string, unknown>

export type JobSchedulerControllerOptions = {
  owner: string
  client: JobsClientInstance
  jobs: readonly AnyJob[]
  logger?: Logger
}

export type SchedulerReconcileResult = {
  desired: number
  added: number
  updated: number
  unchanged: number
  removed: number
  failedRemovals: number
  scheduledJobs: SchedulerScheduledJobsResult
}

export type SchedulerScheduledJobsResult = {
  desired: number
  previous: number
  added: number
  updated: number
  removed: number
}

export type SchedulerRemovalResult = {
  total: number
  removed: number
  failed: number
}

export type SchedulerRemovalReason =
  | 'cutover-start'
  | 'cutover-stop'
  | 'owned-runtime-stop'
  | 'stale-config'

type SchedulerScheduleState = {
  queueName: string
  schedulerId: string
  scheduleId: string
  jobName?: string
  repeat: Record<string, unknown>
  immediately?: boolean
  options: Record<string, unknown>
  data: unknown
}

type SchedulerScheduledJobState = {
  jobName: string
  queueNames: readonly string[]
}

type ScheduleOptionsLike = {
  priority?: unknown
  attempts?: unknown
  backoff?: unknown
  removeOnComplete?: unknown
  removeOnFail?: unknown
}

export function defineScheduler<const Job extends AnyJob>(
  config: SchedulerConfig<Job>,
): SchedulerConfig<Job> {
  return Object.freeze(config)
}

export async function resolveSchedulerConfig<const Job extends AnyJob>(
  config: SchedulerConfig<Job>,
): Promise<ResolvedSchedulerConfig<Job>> {
  return {
    client: config.client,
    jobs: await config.jobs(),
    schedules: await config.schedules(),
    handoff: config.handoff ?? 'continuity',
  }
}

export class JobSchedulerController {
  readonly queues = new Map<string, Queue>()

  constructor(readonly options: JobSchedulerControllerOptions) {}

  async reconcile(
    entries: readonly JobScheduleEntry[],
  ): Promise<SchedulerReconcileResult> {
    const desired = new Map<string, OwnedSchedule>()
    const desiredStates: SchedulerScheduleState[] = []
    const previousSchedules = await this.readOwnedScheduleStates()
    const result: SchedulerReconcileResult = {
      desired: entries.length,
      added: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      failedRemovals: 0,
      scheduledJobs: {
        desired: 0,
        previous: 0,
        added: 0,
        updated: 0,
        removed: 0,
      },
    }

    this.options.logger?.trace(
      { owner: this.options.owner, schedules: entries.length },
      'Scheduler reconcile input',
    )

    for (const entry of entries) {
      this.assertConfiguredJob(entry.job)
      const queue = this.getQueue(entry.job)
      const schedulerId = getOwnedSchedulerId(this.options.owner, entry.id)
      const repeat = toBullRepeatOptions(entry.repeat)
      const template = toBullJobTemplate(entry)
      const current = await queue.getJobScheduler(schedulerId)
      const scheduleKey = registryKey(queue.name, schedulerId)
      const nextState = toScheduleState({
        queueName: queue.name,
        schedulerId,
        scheduleId: entry.id,
        jobName: template.name,
        repeat,
        immediately: entry.repeat.immediately,
        options: template.opts,
        data: template.data,
      })
      desiredStates.push(nextState)

      const previousState = previousSchedules.get(scheduleKey)
      const currentState =
        previousState ??
        (current
          ? mapSchedulerState(queue.name, current, `${this.options.owner}:`)
          : undefined)
      const changes = currentState
        ? getScheduleChanges(currentState, nextState)
        : []

      await queue.upsertJobScheduler(schedulerId, repeat, template)

      if (!currentState) {
        result.added += 1
        this.logSchedule('added', nextState)
      } else if (changes.length > 0) {
        result.updated += 1
        this.logSchedule('updated', nextState, { changes })
      } else {
        result.unchanged += 1
        this.options.logger?.trace(
          this.getScheduleLogObject(nextState),
          'Scheduler schedule unchanged',
        )
      }

      desired.set(scheduleKey, { queueName: queue.name, schedulerId })
    }

    result.scheduledJobs = this.reconcileScheduledJobs(
      [...previousSchedules.values()],
      desiredStates,
    )
    const stale = await this.removeStaleOwned([...desired.values()])
    result.removed = stale.removed
    result.failedRemovals = stale.failed
    await this.writeRegistry([...desired.values()])

    this.options.logger?.trace(
      { owner: this.options.owner, ...result },
      'Scheduler reconcile result',
    )

    return result
  }

  async removeOwned(
    options: { reason?: SchedulerRemovalReason } = {},
  ): Promise<SchedulerRemovalResult> {
    const owned = await this.readRegistry()
    const byQueue = new Map<string, string[]>()
    const reason = options.reason ?? 'owned-runtime-stop'
    const result: SchedulerRemovalResult = {
      total: owned.length,
      removed: 0,
      failed: 0,
    }

    this.options.logger?.debug('Scheduler owned schedules removing')
    this.options.logger?.trace(
      { owner: this.options.owner, schedules: owned.length, reason },
      'Scheduler owned schedules removal input',
    )

    for (const schedule of owned) {
      const ids = byQueue.get(schedule.queueName)
      if (ids) ids.push(schedule.schedulerId)
      else byQueue.set(schedule.queueName, [schedule.schedulerId])
    }

    for (const [queueName, ids] of byQueue) {
      for (const schedulerId of ids) {
        if (await this.removeSchedule({ queueName, schedulerId }, reason)) {
          result.removed += 1
        } else {
          result.failed += 1
        }
      }
    }

    await this.deleteRegistry()

    this.options.logger?.debug('Scheduler owned schedule removal applied')
    this.options.logger?.trace(
      { owner: this.options.owner, reason, ...result },
      'Scheduler owned schedules removal result',
    )

    return result
  }

  async list<T extends AnyJob>(
    job: T,
  ): Promise<JobScheduleInfo<T['_']['input']>[]> {
    const queue = this.getQueue(job)
    const schedules = (await queue.getJobSchedulers()) as JobSchedulerJson<
      T['_']['input']
    >[]
    const owner = `${this.options.owner}:`
    return schedules
      .filter((schedule) => schedule.key.startsWith(owner))
      .map((schedule) => mapJobSchedule(queue.name, schedule, owner))
  }

  async close() {
    const queues = [...this.queues]
    const results = await Promise.allSettled(
      queues.map(([, queue]) => queue.close()),
    )

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      this.options.logger?.warn(
        {
          owner: this.options.owner,
          queueName: queues[index]?.[0],
          err: normalizeError(result.reason),
        },
        'Failed to close scheduler queue',
      )
    })

    this.queues.clear()
  }

  private async removeStaleOwned(
    desired: readonly OwnedSchedule[],
  ): Promise<SchedulerRemovalResult> {
    const desiredKeys = new Set(
      desired.map((item) => registryKey(item.queueName, item.schedulerId)),
    )
    const registry = await this.readRegistry()
    const stale = registry.filter(
      (item) => !desiredKeys.has(registryKey(item.queueName, item.schedulerId)),
    )
    const result: SchedulerRemovalResult = {
      total: stale.length,
      removed: 0,
      failed: 0,
    }

    for (const item of stale) {
      if (await this.removeSchedule(item, 'stale-config')) {
        result.removed += 1
      } else {
        result.failed += 1
      }
    }

    return result
  }

  private async readOwnedScheduleStates(): Promise<
    Map<string, SchedulerScheduleState>
  > {
    const states = new Map<string, SchedulerScheduleState>()
    const ownerPrefix = `${this.options.owner}:`

    for (const item of await this.readRegistry()) {
      const queue = this.getQueueByName(item.queueName)
      const schedule = await queue.getJobScheduler(item.schedulerId)
      if (!schedule) continue

      states.set(
        registryKey(item.queueName, item.schedulerId),
        mapSchedulerState(item.queueName, schedule, ownerPrefix),
      )
    }

    return states
  }

  private getQueue(job: AnyJob) {
    return this.getQueueByName(getJobQueueName(job))
  }

  private getQueueByName(queueName: string) {
    let queue = this.queues.get(queueName)
    if (!queue) {
      queue = new Queue(queueName, {
        connection: this.options.client as unknown as RedisClient,
      })
      this.queues.set(queueName, queue)
    }
    return queue
  }

  private assertConfiguredJob(job: AnyJob) {
    if (this.options.jobs.some((configured) => configured.name === job.name)) {
      return
    }
    throw new Error(
      `Invalid schedule job [${job.name}]: job is not configured in scheduler runtime`,
    )
  }

  private async readRegistry(): Promise<OwnedSchedule[]> {
    const raw = await this.options.client.get(this.registryKey())
    if (!raw) return []
    const parsed = JSON.parse(raw) as OwnedSchedule[]
    return Array.isArray(parsed) ? parsed : []
  }

  private async writeRegistry(items: readonly OwnedSchedule[]) {
    await this.options.client.set(this.registryKey(), JSON.stringify(items))
  }

  private async deleteRegistry() {
    await this.options.client.del(this.registryKey())
  }

  private registryKey() {
    return `nmtjs:scheduler:${this.options.owner}:schedules`
  }

  private async removeSchedule(
    schedule: OwnedSchedule,
    reason: SchedulerRemovalReason,
  ): Promise<boolean> {
    const logObject = {
      owner: this.options.owner,
      queueName: schedule.queueName,
      schedulerId: schedule.schedulerId,
      scheduleId: getScheduleId(this.options.owner, schedule.schedulerId),
      reason,
    }

    try {
      const queue = this.getQueueByName(schedule.queueName)
      await queue.removeJobScheduler(schedule.schedulerId)
      this.options.logger?.trace(logObject, 'Scheduler schedule removed')
      return true
    } catch (error) {
      this.options.logger?.warn(
        { ...logObject, err: normalizeError(error) },
        'Failed to remove scheduler schedule',
      )
      return false
    }
  }

  private logSchedule(
    action: 'added' | 'updated',
    schedule: SchedulerScheduleState,
    extra: SchedulerLogObject = {},
  ) {
    this.options.logger?.trace(
      { ...this.getScheduleLogObject(schedule), ...extra },
      `Scheduler schedule ${action}`,
    )
  }

  private getScheduleLogObject(
    schedule: SchedulerScheduleState,
  ): SchedulerLogObject {
    return {
      owner: this.options.owner,
      queueName: schedule.queueName,
      schedulerId: schedule.schedulerId,
      scheduleId: schedule.scheduleId,
      jobName: schedule.jobName,
      repeat: schedule.repeat,
      immediately: schedule.immediately,
      options: schedule.options,
      hasData: schedule.data !== undefined,
    }
  }

  private reconcileScheduledJobs(
    previousSchedules: readonly SchedulerScheduleState[],
    desiredSchedules: readonly SchedulerScheduleState[],
  ): SchedulerScheduledJobsResult {
    const previous = collectScheduledJobs(previousSchedules)
    const desired = collectScheduledJobs(desiredSchedules)
    const result: SchedulerScheduledJobsResult = {
      desired: desired.size,
      previous: previous.size,
      added: 0,
      updated: 0,
      removed: 0,
    }

    for (const [jobName, job] of desired) {
      if (previous.has(jobName)) {
        result.updated += 1
        this.logScheduledJob('updated', job, {
          reason: 'present-before-and-after-deployment',
        })
      } else {
        result.added += 1
        this.logScheduledJob('added', job)
      }
    }

    for (const [jobName, job] of previous) {
      if (desired.has(jobName)) continue

      result.removed += 1
      this.logScheduledJob('removed', job)
    }

    return result
  }

  private logScheduledJob(
    action: 'added' | 'updated' | 'removed',
    job: SchedulerScheduledJobState,
    extra: SchedulerLogObject = {},
  ) {
    this.options.logger?.trace(
      { owner: this.options.owner, ...job, ...extra },
      `Scheduler scheduled job ${action}`,
    )
  }
}

export function getOwnedSchedulerId(owner: string, id: string) {
  return `${owner}:${id}`
}

function registryKey(queueName: string, schedulerId: string) {
  return `${queueName}:${schedulerId}`
}

function toBullRepeatOptions(
  repeat: JobScheduleEntry['repeat'],
): Omit<RepeatOptions, 'key'> {
  const options: Omit<RepeatOptions, 'key'> = {}

  if ('cron' in repeat) options.pattern = repeat.cron
  if ('every' in repeat) options.every = repeat.every
  if (repeat.limit !== undefined) options.limit = repeat.limit
  if (repeat.immediately !== undefined) options.immediately = repeat.immediately
  if (repeat.timezone !== undefined) options.tz = repeat.timezone

  return options
}

function toBullJobTemplate(entry: JobScheduleEntry) {
  return {
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
  }
}

function mapJobSchedule<TData>(
  queueName: string,
  schedule: JobSchedulerJson<TData>,
  ownerPrefix: string,
): JobScheduleInfo<TData> {
  return {
    id: schedule.key.startsWith(ownerPrefix)
      ? schedule.key.slice(ownerPrefix.length)
      : schedule.key,
    schedulerId: schedule.key,
    jobName: schedule.name,
    queueName,
    data: schedule.template?.data,
    next: schedule.next,
    every: schedule.every,
    cron: schedule.pattern,
    timezone: schedule.tz,
  }
}

function mapSchedulerState(
  queueName: string,
  schedule: JobSchedulerJson,
  ownerPrefix: string,
): SchedulerScheduleState {
  return toScheduleState({
    queueName,
    schedulerId: schedule.key,
    scheduleId: schedule.key.startsWith(ownerPrefix)
      ? schedule.key.slice(ownerPrefix.length)
      : schedule.key,
    jobName: schedule.name,
    repeat: {
      pattern: schedule.pattern,
      every: schedule.every,
      limit: schedule.limit,
      tz: schedule.tz,
    },
    options: schedule.template?.opts,
    data: schedule.template?.data,
  })
}

function toScheduleState(input: {
  queueName: string
  schedulerId: string
  scheduleId: string
  jobName?: string
  repeat: Pick<RepeatOptions, 'pattern' | 'every' | 'limit' | 'tz'>
  immediately?: boolean
  options?: ScheduleOptionsLike
  data: unknown
}): SchedulerScheduleState {
  return {
    queueName: input.queueName,
    schedulerId: input.schedulerId,
    scheduleId: input.scheduleId,
    jobName: input.jobName,
    repeat: cleanObject({
      cron: input.repeat.pattern,
      every: input.repeat.every,
      limit: input.repeat.limit,
      timezone: input.repeat.tz,
    }),
    immediately: input.immediately === true ? true : undefined,
    options: cleanObject({
      priority: input.options?.priority,
      attempts: input.options?.attempts,
      backoff: input.options?.backoff,
      removeOnComplete: input.options?.removeOnComplete,
      removeOnFail: input.options?.removeOnFail,
    }),
    data: input.data,
  }
}

function getScheduleChanges(
  current: SchedulerScheduleState,
  next: SchedulerScheduleState,
): SchedulerLogObject[] {
  const changes: SchedulerLogObject[] = []

  if (current.jobName !== next.jobName) {
    changes.push({ field: 'jobName', from: current.jobName, to: next.jobName })
  }

  if (stableStringify(current.repeat) !== stableStringify(next.repeat)) {
    changes.push({ field: 'repeat', from: current.repeat, to: next.repeat })
  }

  if (stableStringify(current.options) !== stableStringify(next.options)) {
    changes.push({ field: 'options', from: current.options, to: next.options })
  }

  if (stableStringify(current.data) !== stableStringify(next.data)) {
    changes.push({ field: 'data', changed: true })
  }

  return changes
}

function collectScheduledJobs(
  schedules: readonly SchedulerScheduleState[],
): Map<string, SchedulerScheduledJobState> {
  const queueNamesByJob = new Map<string, Set<string>>()

  for (const schedule of schedules) {
    if (!schedule.jobName) continue

    const queueNames = queueNamesByJob.get(schedule.jobName)
    if (queueNames) queueNames.add(schedule.queueName)
    else queueNamesByJob.set(schedule.jobName, new Set([schedule.queueName]))
  }

  return new Map(
    [...queueNamesByJob].map(([jobName, queueNames]) => [
      jobName,
      { jobName, queueNames: [...queueNames].sort() },
    ]),
  )
}

function getScheduleId(owner: string, schedulerId: string): string {
  const prefix = `${owner}:`
  return schedulerId.startsWith(prefix)
    ? schedulerId.slice(prefix.length)
    : schedulerId
}

function cleanObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stableValue)

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  )
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
