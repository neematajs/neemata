import type { AnyJob, JobBackoffOptions } from './job.ts'

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
  jobName?: string
  queueName: string
  data?: TData
  next?: number
  every?: number
  cron?: string
  timezone?: string
}
