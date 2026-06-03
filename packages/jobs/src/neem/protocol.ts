export type JobsWorkerTask = { jobId: string; jobName: string; data: unknown }

export type JobsWorkerTaskResult =
  | { type: 'success'; result?: unknown }
  | { type: 'error'; error: unknown }
  | { type: 'unrecoverable_error'; error: unknown }
  | { type: 'job_not_found' }
  | { type: 'queue_job_not_found' }

export type JobsWorkerRequest = {
  type: 'task'
  id: string
  task: JobsWorkerTask
}

export type JobsWorkerResponse = {
  type: 'task'
  id: string
  task: JobsWorkerTaskResult
}

export type JobsWorkerData = { poolName: string }
