import type { Connection } from './connection.ts'
import { Scope, type WorkerType } from './constants.ts'
import { Provider } from './container.ts'
import type { EventManager } from './events.ts'
import type { Logger } from './logger.ts'
import type { SubscriptionManager } from './subscription.ts'
import type { ExecuteFn } from './types.ts'

const connection = new Provider<Connection>().withScope(Scope.Connection)

const connectionData = new Provider<unknown>().withScope(Scope.Connection)

const callSignal = new Provider<AbortSignal>().withScope(Scope.Call)

const taskSignal = new Provider<AbortSignal>().withScope(Scope.Global)

const logger = new Provider<Logger>().withScope(Scope.Global)

const execute = new Provider<ExecuteFn>().withScope(Scope.Global)

const workerType = new Provider<WorkerType>().withScope(Scope.Global)

const eventManager = new Provider<EventManager>().withScope(Scope.Global)

const subManager = new Provider<SubscriptionManager>().withScope(Scope.Global)

export const providers = {
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
