import type { AnyJob, JobBackoffOptions } from './job.ts'
import type { JobScheduleEntry, JobScheduleInfo } from './scheduler.ts'
import type { JobDefinitionInfo, JobItem, JobStatus } from './types.ts'

export type JobItemOf<T extends AnyJob = AnyJob> = JobItem<
  T['_']['input'],
  T['_']['output']
>

export type JobAddOptions = {
  jobId?: string
  priority?: number
  forceMissingWorkers?: boolean
  attempts?: number
  backoff?: JobBackoffOptions
  oneoff?: boolean
  delay?: number
}

export interface JobResult<T extends AnyJob = AnyJob> {
  readonly id: string
  readonly name: T['options']['name']
  waitResult(): Promise<T['_']['output']>
}

export interface JobsManager {
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
    options?: JobAddOptions,
  ): Promise<JobResult<T>>
  schedule<T extends AnyJob>(entry: JobScheduleEntry<T>): Promise<JobResult<T>>
  unschedule(job: AnyJob, id: string): Promise<void>
  listSchedules<T extends AnyJob>(
    job: T,
  ): Promise<JobScheduleInfo<T['_']['input']>[]>
  retry(
    job: AnyJob,
    id: string,
    options?: { clearState?: boolean },
  ): Promise<void>
  remove(job: AnyJob, id: string): Promise<void>
  cancel(job: AnyJob, id: string): Promise<void>
}
