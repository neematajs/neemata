import type { MaybePromise } from '@nmtjs/common'
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

  constructor(
    readonly options: {
      owner: string
      client: JobsClientInstance
      jobs: readonly AnyJob[]
    },
  ) {}

  async reconcile(entries: readonly JobScheduleEntry[]) {
    const desired = new Map<string, OwnedSchedule>()

    for (const entry of entries) {
      this.assertConfiguredJob(entry.job)
      const queue = this.getQueue(entry.job)
      const schedulerId = getOwnedSchedulerId(this.options.owner, entry.id)
      await queue.upsertJobScheduler(
        schedulerId,
        toBullRepeatOptions(entry.repeat),
        {
          name: entry.job.options.name,
          data: entry.data,
          opts: {
            priority: entry.options?.priority,
            attempts: entry.options?.attempts ?? entry.job.options.attempts,
            backoff: entry.options?.backoff ?? entry.job.options.backoff,
            removeOnComplete:
              entry.options?.removeOnComplete ??
              entry.job.options.oneoff ??
              true,
            removeOnFail:
              entry.options?.removeOnFail ?? entry.job.options.oneoff ?? true,
          },
        },
      )
      desired.set(registryKey(queue.name, schedulerId), {
        queueName: queue.name,
        schedulerId,
      })
    }

    await this.removeStaleOwned([...desired.values()])
    await this.writeRegistry([...desired.values()])
  }

  async removeOwned() {
    const owned = await this.readRegistry()
    const byQueue = new Map<string, string[]>()

    for (const schedule of owned) {
      const ids = byQueue.get(schedule.queueName)
      if (ids) ids.push(schedule.schedulerId)
      else byQueue.set(schedule.queueName, [schedule.schedulerId])
    }

    for (const [queueName, ids] of byQueue) {
      const queue = this.getQueueByName(queueName)
      await Promise.allSettled(ids.map((id) => queue.removeJobScheduler(id)))
    }

    await this.deleteRegistry()
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
    await Promise.allSettled(
      [...this.queues.values()].map((queue) => queue.close()),
    )
    this.queues.clear()
  }

  private async removeStaleOwned(desired: readonly OwnedSchedule[]) {
    const desiredKeys = new Set(
      desired.map((item) => registryKey(item.queueName, item.schedulerId)),
    )
    const stale = (await this.readRegistry()).filter(
      (item) => !desiredKeys.has(registryKey(item.queueName, item.schedulerId)),
    )

    for (const item of stale) {
      const queue = this.getQueueByName(item.queueName)
      await queue.removeJobScheduler(item.schedulerId).catch(() => false)
    }
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
