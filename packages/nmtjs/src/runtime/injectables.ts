import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { JobWorkerPool, WorkerType } from './enums.ts'
import type { JobManagerInstance } from './jobs/manager.ts'
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

export const RuntimeInjectables = {
  pubSubAdapter,
  pubSubPublish,
  pubSubSubscribe,
  jobManager,
  storeConfig,
  workerType,
  jobWorkerPool,
}
