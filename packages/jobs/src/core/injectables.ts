import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { JobsManager } from './queue.ts'
import type { JobExecutionContext, SaveJobProgress } from './types.ts'

export const jobManager = createLazyInjectable<JobsManager>(
  Scope.Global,
  'JobManager',
)

export const jobWorkerPool = createLazyInjectable<string>(
  Scope.Global,
  'JobWorkerPool',
)

export const jobAbortSignal = createLazyInjectable<AbortSignal>(
  Scope.Global,
  'JobAbortSignal',
)

export const saveJobProgress = createLazyInjectable<SaveJobProgress>(
  Scope.Global,
  'SaveJobProgress',
)

export const currentJobInfo = createLazyInjectable<JobExecutionContext>(
  Scope.Global,
  'CurrentJobInfo',
)

export const JobInjectables = {
  jobManager,
  jobWorkerPool,
  jobAbortSignal,
  saveJobProgress,
  currentJobInfo,
}
