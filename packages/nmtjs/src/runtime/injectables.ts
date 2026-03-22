import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { JobWorkerPool, WorkerType } from './enums.ts'
import type { JobManagerInstance } from './jobs/manager.ts'
import type { JobExecutionContext, SaveJobProgress } from './jobs/types.ts'
import type { ServerStoreConfig } from './server/config.ts'
import type {
  PublishFn,
  SubscribeFn,
  SubscriptionAdapterType,
} from './subscription/manager.ts'

export const subscriptionAdapter =
  createLazyInjectable<SubscriptionAdapterType>(
    Scope.Global,
    'SubscriptionAdapter',
  )

export const publish = createLazyInjectable<PublishFn>(Scope.Global, 'Publish')

export const subscribe = createLazyInjectable<SubscribeFn>(
  Scope.Global,
  'Subscribe',
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
  subscriptionAdapter,
  publish,
  subscribe,
  jobManager,
  storeConfig,
  workerType,
  jobWorkerPool,
  jobAbortSignal,
  saveJobProgress,
  currentJobInfo,
}
