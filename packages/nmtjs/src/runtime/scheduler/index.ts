import type { AnyJob } from '../jobs/job.ts'

export interface JobsSchedulerEntry<T extends AnyJob = AnyJob> {
  job: T
  data: T['_']['input']
  cron: string
}

export type JobsSchedulerOptions = { entries: JobsSchedulerEntry[] }

/**
 * @deprecated Job scheduler is currently being refactored and is not available.
 * This will throw an error if instantiated.
 */
export class JobsScheduler {
  constructor() {
    throw new Error(
      'JobsScheduler is currently a work in progress and not available. ' +
        'Scheduled jobs will be supported in a future release.',
    )
  }

  async initialize() {}
  async stop() {}
}

/**
 * @deprecated Job scheduler is currently being refactored and is not available.
 */
export function createSchedulerJobEntry<T extends AnyJob>(
  job: T,
  data: T['_']['input'],
  cron: string,
): JobsSchedulerEntry<T> {
  throw new Error(
    'createSchedulerJobEntry is currently a work in progress and not available. ' +
      'Scheduled jobs will be supported in a future release.',
  )
}
