import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { EventingAdapter } from './adapter.ts'
import type { ProduceFn } from './manager.ts'

export const eventingAdapter = createLazyInjectable<EventingAdapter>(
  Scope.Global,
  'EventingAdapter',
)

export const produce = createLazyInjectable<ProduceFn>(Scope.Global, 'Produce')

export const EventingInjectables = { eventingAdapter, produce }
