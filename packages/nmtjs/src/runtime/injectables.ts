import {
  CoreInjectables,
  createFactoryInjectable,
  createLazyInjectable,
  Scope,
} from '@nmtjs/core'

import type { WorkerType } from './enums.ts'
import type { JobManagerInstance } from './jobs/manager.ts'
import type { JobExecutionContext, SaveJobProgress } from './jobs/types.ts'
import type { ServerStoreConfig } from './server/config.ts'
import type {
  PublishFn,
  SubscribeFn,
  SubscriptionAdapterType,
} from './subscription/manager.ts'
import { SubscriptionManager } from './subscription/manager.ts'

export const subscriptionAdapter =
  createLazyInjectable<SubscriptionAdapterType>(
    Scope.Global,
    'SubscriptionAdapter',
  )

export const subscriptionManager = createFactoryInjectable(
  {
    dependencies: {
      adapter: subscriptionAdapter,
      logger: CoreInjectables.logger,
    },
    factory: ({ adapter, logger }) =>
      new SubscriptionManager({ logger, adapter }),
    dispose: (manager) => manager.dispose(),
  },
  'SubscriptionManager',
)

export const publish = createFactoryInjectable(
  {
    dependencies: { manager: subscriptionManager },
    factory: ({ manager }): PublishFn => manager.publish.bind(manager),
  },
  'Publish',
)

export const subscribe = createFactoryInjectable(
  {
    dependencies: { manager: subscriptionManager },
    factory: ({ manager }): SubscribeFn => manager.subscribe.bind(manager),
  },
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

export const RuntimeInjectables = {
  subscriptionAdapter,
  subscriptionManager,
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
