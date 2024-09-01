import type { Connection } from './connection.ts'
import { Scope, type WorkerType } from './constants.ts'
import { createLazyInjectable } from './container.ts'
import type { EventManager } from './events.ts'
import type { Logger } from './logger.ts'
import type { SubscriptionManager } from './subscription.ts'
import type { ExecuteFn } from './types.ts'

const connection = createLazyInjectable<Connection, Scope.Connection>(
  Scope.Connection,
)
const connectionData = createLazyInjectable<unknown, Scope.Connection>(
  Scope.Connection,
)
const callSignal = createLazyInjectable<AbortSignal, Scope.Call>(Scope.Call)
const taskSignal = createLazyInjectable<AbortSignal>(Scope.Global)
const logger = createLazyInjectable<Logger>(Scope.Global)
const execute = createLazyInjectable<ExecuteFn>(Scope.Global)
const workerType = createLazyInjectable<WorkerType>(Scope.Global)
const eventManager = createLazyInjectable<EventManager>(Scope.Global)
const subManager = createLazyInjectable<SubscriptionManager>(Scope.Global)

export const injectables = {
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
