import type { Connection } from './connection.ts'
import { Scope, type WorkerType } from './constants.ts'
import { Provider } from './container.ts'
import type { EventManager } from './events.ts'
import type { Logger } from './logger.ts'
import type { SubscriptionManager } from './subscription.ts'
import type { ExecuteFn } from './types.ts'

const connection = new Provider<Connection>()
  .withScope(Scope.Connection)
  .withDescription('RPC connection')

const connectionData = new Provider<unknown>()
  .withScope(Scope.Connection)
  .withDescription('RPC connection data')

const callSignal = new Provider<AbortSignal>()
  .withScope(Scope.Call)
  .withDescription('RPC abort signal')

const taskSignal = new Provider<AbortSignal>()
  .withScope(Scope.Global)
  .withDescription('Task execution abort signal')

const logger = new Provider<Logger>()
  .withScope(Scope.Global)
  .withDescription('Logger')

const execute = new Provider<ExecuteFn>()
  .withScope(Scope.Global)
  .withDescription('Task execution function')

const workerType = new Provider<WorkerType>()
  .withScope(Scope.Global)
  .withDescription('Worker type')

const eventManager = new Provider<EventManager>()
  .withScope(Scope.Global)
  .withDescription('Event manager')

const subManager = new Provider<SubscriptionManager>()
  .withScope(Scope.Global)
  .withDescription('Subscription manager')

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
