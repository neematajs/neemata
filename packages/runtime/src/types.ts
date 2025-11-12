export type ServerPortMessage =
  | { type: 'ready'; data?: never }
  | { type: 'task'; data: { id: string; data: JobTaskResult } }

export type ThreadPortMessage =
  | { type: 'stop' }
  | { type: 'task'; data: { id: string; data: WorkerJobTask } }

export interface WorkerTask {
  type?: string
  data?: any
}

export type WorkerJobTask = { jobId: string; jobName: string }

export type JobTaskResult = {
  [K in keyof JobTaskResultTypes]: { type: K } & JobTaskResultTypes[K]
}[keyof JobTaskResultTypes]

export type JobTaskResultTypes = {
  success: { result?: unknown }
  error: { error: Error }
  job_not_found: {}
  queue_job_not_found: {}
}
