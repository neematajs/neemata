import type { Connection } from './connection.ts'
import { Scope, type WorkerType } from './constants.ts'
import { Injectable } from './container.ts'
import type { EventManager } from './events.ts'
import type { Logger } from './logger.ts'
import type { SubscriptionManager } from './subscription.ts'
import type { ExecuteFn } from './types.ts'

const connection = new Injectable<Connection>().withScope(Scope.Connection)

const connectionData = new Injectable<unknown>().withScope(Scope.Connection)

const callSignal = new Injectable<AbortSignal>().withScope(Scope.Call)

const taskSignal = new Injectable<AbortSignal>().withScope(Scope.Global)

const logger = new Injectable<Logger>().withScope(Scope.Global)

const execute = new Injectable<ExecuteFn>().withScope(Scope.Global)

const workerType = new Injectable<WorkerType>().withScope(Scope.Global)

const eventManager = new Injectable<EventManager>().withScope(Scope.Global)

const subManager = new Injectable<SubscriptionManager>().withScope(Scope.Global)

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
