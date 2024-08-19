import type { ApiBlob, ApiBlobInterface } from '@nmtjs/common'
import type { Api, Guard, Middleware, Procedure } from './api.ts'
import type { Application } from './application.ts'
import type { Connection, ConnectionOptions } from './connection.ts'
import type { Hook, WorkerType } from './constants.ts'
import type { Container, Provider } from './container.ts'
import type { EventManager } from './events.ts'
import type { Format } from './format.ts'
import type { Hooks } from './hooks.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import type { Service } from './service.ts'
import type { ServerUpStream } from './stream.ts'
import type { Task, TaskExecution } from './task.ts'

export type ClassConstructor<T> = new (...args: any[]) => T
export type Callback = (...args: any[]) => any
export type OmitFirstItem<T extends any[]> = T extends [any, ...infer U]
  ? U
  : []
export type ErrorClass = new (...args: any[]) => Error
export type Extra = Record<string, any>
export type Async<T> = T | Promise<T>

export type GuardOptions = {
  connection: Connection
}

export type Command = (options: {
  args: string[]
  kwargs: Record<string, any>
}) => any

export type FilterFn<T extends ErrorClass = ErrorClass> = (
  error: InstanceType<T>,
) => Async<Error>

export type GuardFn = (options: GuardOptions) => Async<boolean>

export type MiddlewareFn = (
  options: MiddlewareContext,
  next: Next,
  payload: any,
) => any

export type AnyApplication = Application
export type AnyService = Service<any>
export type AnyProvider<Value = any> = Provider<Value, any>
export type AnyProcedure = Procedure<any, any>
export type AnyTask = Task<any, any, any, any>
export type AnyGuard = Guard<any>
export type AnyMiddleware = Middleware<any>

export type MiddlewareContext = {
  connection: Connection
  container: Container
  procedure: AnyProcedure
  service: AnyService
}

export type Next = (payload?: any) => any

export interface HooksInterface {
  [Hook.BeforeInitialize]: () => any
  [Hook.AfterInitialize]: () => any
  [Hook.OnStartup]: () => any
  [Hook.OnShutdown]: () => any
  [Hook.BeforeTerminate]: () => any
  [Hook.AfterTerminate]: () => any
  [Hook.OnConnect]: (connection: Connection) => any
  [Hook.OnDisconnect]: (connection: Connection) => any
}

export type CallHook<T extends string> = (
  hook: T,
  ...args: T extends keyof HooksInterface
    ? Parameters<HooksInterface[T]>
    : any[]
) => Promise<void>

export interface ApplicationContext {
  type: WorkerType
  api: Api
  format: Format
  container: Container
  eventManager: EventManager
  logger: Logger
  registry: Registry
  hooks: Hooks
  connections: {
    add: (options: ConnectionOptions) => Connection
    remove: (connectionOrId: Connection | Connection['id']) => void
    get: (id: Connection['id']) => Connection | undefined
  }
}

export type UnionToIntersection<U> = (
  U extends any
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never

export type ExecuteFn = <T extends AnyTask>(
  task: T,
  ...args: T['_']['args']
) => TaskExecution<T['_']['type']>

export type Merge<
  T1 extends Record<string, any>,
  T2 extends Record<string, any>,
> = {
  [K in keyof T1 | keyof T2]: K extends keyof T2
    ? T2[K]
    : K extends keyof T1
      ? T1[K]
      : never
}

export type OutputType<T> = T extends any[]
  ? Array<OutputType<T[number]>>
  : T extends ApiBlobInterface
    ? ApiBlob
    : T extends object
      ? { [K in keyof T]: OutputType<T[K]> }
      : T

export type InputType<T> = T extends any[]
  ? Array<InputType<T[number]>>
  : T extends ApiBlobInterface
    ? ServerUpStream
    : T extends object
      ? { [K in keyof T]: InputType<T[K]> }
      : T
