import type { Connection } from './connection.ts'
import { Scope, type WorkerType } from './constants.ts'
import { createLazyInjectable } from './container.ts'
import type { EventManager } from './events.ts'
import type { Logger } from './logger.ts'
import type { SubscriptionManager } from './subscription.ts'
import type { ExecuteFn } from './types.ts'

const connection = createLazyInjectable<Connection, Scope.Connection>(
  Scope.Connection,
  'RPC connection',
)
const connectionData = createLazyInjectable<unknown, Scope.Connection>(
  Scope.Connection,
  "RPC connection's data",
)
const callSignal = createLazyInjectable<AbortSignal, Scope.Call>(
  Scope.Call,
  'RPC abort signal',
)
const taskSignal = createLazyInjectable<AbortSignal>(Scope.Global, '')
const logger = createLazyInjectable<Logger>(Scope.Global, 'Logger')
const execute = createLazyInjectable<ExecuteFn>(Scope.Global, 'Task executor')
const workerType = createLazyInjectable<WorkerType>(
  Scope.Global,
  'Application worker type',
)
const eventManager = createLazyInjectable<EventManager>(
  Scope.Global,
  'Event manager',
)
const subManager = createLazyInjectable<SubscriptionManager>(
  Scope.Global,
  'Subscription manager',
)

export const builtin = {
  connection,
  connectionData,
  callSignal,
  taskSignal,
  logger,
  execute,
  eventManager,
  subManager,
  workerType,
}

export const injectables = builtin
