import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { JobManagerInstance } from './jobs/manager.ts'
import type { PubSubAdapterType, PubSubManager } from './pubsub/manager.ts'
import type { ServerStoreConfig } from './server/config.ts'

export const pubSubAdapter = createLazyInjectable<PubSubAdapterType>(
  Scope.Global,
  'PubSubAdapter',
)

export const pubSubPublish = createLazyInjectable<PubSubManager['publish']>(
  Scope.Global,
  'PubSubPublish',
)

export const pubSubSubscribe = createLazyInjectable<PubSubManager['subscribe']>(
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

export const RuntimeInjectables = {
  pubSubAdapter,
  pubSubPublish,
  pubSubSubscribe,
  jobManager,
  storeConfig,
}
