import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { PubSubAdapter } from './adapter.ts'
import type { PublishFn, SubscribeFn } from './manager.ts'

export const pubsubAdapter = createLazyInjectable<PubSubAdapter>(
  Scope.Global,
  'PubSubAdapter',
)

export const publish = createLazyInjectable<PublishFn>(Scope.Global, 'Publish')

export const subscribe = createLazyInjectable<SubscribeFn>(
  Scope.Global,
  'Subscribe',
)

export const PubSubInjectables = { pubsubAdapter, publish, subscribe }
