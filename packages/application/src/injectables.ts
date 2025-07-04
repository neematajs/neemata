import { createLazyInjectable, Scope } from '@nmtjs/core'
import type { WorkerType } from './enums.ts'
import type { PubSub, PubSubAdapter } from './pubsub.ts'
import type { ExecuteFn } from './types.ts'

const appShutdownSignal = createLazyInjectable<AbortSignal>(
  Scope.Global,
  'Application shutdown signal',
)
const taskAbortSignal = createLazyInjectable<AbortSignal>(
  Scope.Global,
  'Task abort signal',
)
const pubsub = createLazyInjectable<PubSub>(
  Scope.Global,
  'Subscription manager',
)
const pubsubAdapter = createLazyInjectable<PubSubAdapter>(
  Scope.Global,
  'Subscription manager adapter',
)
const execute = createLazyInjectable<ExecuteFn>(Scope.Global, 'Task executor')
const workerType = createLazyInjectable<WorkerType>(
  Scope.Global,
  'Application worker type',
)

export const AppInjectables = {
  appShutdownSignal,
  taskAbortSignal,
  workerType,
  execute,
  pubsub,
  pubsubAdapter,
}
