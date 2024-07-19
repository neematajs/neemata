import type {
  Decoded,
  Encoded,
  TBaseProcedureContract,
  TSchema,
} from '@neematajs/contract'
import type { UpStream } from '@neematajs/contract'
import type { Api, Guard, Middleware, Procedure } from './api'
import type { Application } from './application'
import type { Hook, WorkerType } from './constants'
import type { Container, Provider } from './container'
import type { EventManager } from './events'
import type { BaseExtension } from './extension'
import type { Format } from './format'
import type { Logger } from './logger'
import type { Registry } from './registry'
import type { Service } from './service'
import type { Stream } from './streams'
import type { Task, TaskExecution } from './tasks'
import type { BaseTransport, BaseTransportConnection } from './transport'

export type ClassConstructor<T> = new (...args: any[]) => T
export type Callback = (...args: any[]) => any
export type Pattern = RegExp | string | ((value: string) => boolean)
export type OmitFirstItem<T extends any[]> = T extends [any, ...infer U]
  ? U
  : []
export type ErrorClass = new (...args: any[]) => Error
export type Extra = Record<string, any>
export type Async<T> = T | Promise<T>

export type GuardOptions = {
  connection: BaseTransportConnection
}

export type Command = (options: {
  args: string[]
  kwargs: Record<string, any>
}) => any

export type ConnectionFn<T = any, C = any> = (transportData: T) => Async<C>

export type FilterFn<T extends ErrorClass = ErrorClass> = (
  error: InstanceType<T>,
) => Async<Error>

export type GuardFn = (options: GuardOptions) => Async<boolean>

export type MiddlewareFn = (
  options: MiddlewareContext,
  next: Next,
  payload: any,
) => any

export type ConnectionProvider<T, C> = Provider<ConnectionFn<T, C>>

export type AnyApplication = Application
export type AnyService = Service<any>
export type AnyProvider<Value = any> = Provider<Value, any>
export type AnyProcedure = Procedure<any, any, any>
export type AnyTask = Task<any, any, any, any>
export type AnyGuard = Guard<any>
export type AnyMiddleware = Middleware<any>
export type AnyTransportClass = ClassConstructor<
  BaseTransport<string, BaseTransportConnection, any>
>

export type MiddlewareContext = {
  connection: BaseTransportConnection
  container: Container
  procedure: AnyProcedure
  service: AnyService
}

export type Next = (payload?: any) => any

export interface HooksInterface {
  [Hook.BeforeInitialize]: () => any
  [Hook.AfterInitialize]: () => any
  [Hook.BeforeStart]: () => any
  [Hook.AfterStart]: () => any
  [Hook.BeforeStop]: () => any
  [Hook.AfterStop]: () => any
  [Hook.BeforeTerminate]: () => any
  [Hook.AfterTerminate]: () => any
  [Hook.OnConnection]: (connection: BaseTransportConnection) => any
  [Hook.OnDisconnection]: (connection: BaseTransportConnection) => any
}

export type CallHook<T extends string> = (
  hook: T,
  ...args: T extends keyof HooksInterface
    ? Parameters<HooksInterface[T]>
    : any[]
) => Promise<void>

export interface ExtensionApplication {
  type: WorkerType
  api: Api
  format: Format
  container: Container
  eventManager: EventManager
  logger: Logger
  connections: {
    add: (connection: BaseTransportConnection) => void
    remove: (connection: BaseTransportConnection | string) => void
    get: (id: string) => BaseTransportConnection | undefined
  }
  registry: Registry
}

export type ResolveExtensionContext<
  Extensions extends Record<string, BaseExtension>,
> = {
  [K in keyof Extensions]: Extensions[K] extends BaseExtension<infer Context>
    ? Context
    : never
}

export type UnionToIntersection<U> = (
  U extends any
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never

export type GlobalContext = {
  logger: Logger
}

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

export type DecodeType<T> = T extends any[]
  ? Array<DecodeType<T[number]>>
  : T extends object
    ? { [K in keyof T]: DecodeType<T[K]> }
    : T extends UpStream
      ? Stream
      : T

export type DecodeInputSchema<T extends TSchema> = DecodeType<Decoded<T>>
