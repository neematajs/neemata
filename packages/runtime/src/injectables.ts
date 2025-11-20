import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { JobManagerInstance } from './jobs/manager.ts'
import type { PubSub, PubSubAdapterType } from './pubsub/index.ts'
import type { ServerStoreConfig } from './server/config.ts'

export const PubSubAdapter = createLazyInjectable<PubSubAdapterType>(
  Scope.Global,
  'PubSubAdapter',
)

export const PubSubPublish = createLazyInjectable<PubSub['publish']>(
  Scope.Global,
  'PubSubPublish',
)

export const PubSubSubscribe = createLazyInjectable<PubSub['subscribe']>(
  Scope.Global,
  'PubSubSubscribe',
)

export const JobManager = createLazyInjectable<JobManagerInstance>(
  Scope.Global,
  'JobManager',
)

export const StoreConfig = createLazyInjectable<ServerStoreConfig>(
  Scope.Global,
  'StoreConfig',
)
