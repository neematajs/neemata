import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { JobWorkerPool, WorkerType } from './enums.ts'
import type { JobManagerInstance } from './jobs/manager.ts'
import type { JobExecutionContext, SaveJobProgress } from './jobs/types.ts'
import type {
  PubSubAdapterType,
  PubSubPublish,
  PubSubSubscribe,
} from './pubsub/manager.ts'
import type { ServerStoreConfig } from './server/config.ts'

export const pubSubAdapter = createLazyInjectable<PubSubAdapterType>(
  Scope.Global,
  'PubSubAdapter',
)

export const pubSubPublish = createLazyInjectable<PubSubPublish>(
  Scope.Global,
  'PubSubPublish',
)

export const pubSubSubscribe = createLazyInjectable<PubSubSubscribe>(
  Scope.Global,
  'PubSubSubscribe',
)

export const jobManager = createLazyInjectable<JobManagerInstance>(
  Scope.Global,
  'JobManager',
)

export const storeConfig = createLazyInjectable<ServerStoreConfig>(
  Scope.Global,
  'StoreConfig',
)

export const workerType = createLazyInjectable<WorkerType>(
  Scope.Global,
  'WorkerType',
)

export const jobWorkerPool = createLazyInjectable<JobWorkerPool>(
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

export const RuntimeInjectables = {
  pubSubAdapter,
  pubSubPublish,
  pubSubSubscribe,
  jobManager,
  storeConfig,
  workerType,
  jobWorkerPool,
  jobAbortSignal,
  saveJobProgress,
  currentJobInfo,
}
