import type { Api, Guard, Middleware, Procedure } from './api'
import type { Application } from './application'
import type { Hook, WorkerType } from './constants'
import type { Container, Provider } from './container'
import type { Event } from './events'
import type { BaseExtension } from './extension'
import type { Format } from './format'
import type { Logger } from './logger'
import type { Module } from './module'
import type { Registry } from './registry'
import type { Task, TaskExecution } from './tasks'
import type { BaseTransportConnection } from './transport'

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
  path: ApiPath
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

export type AnyApplication = Application<any>
export type AnyModule = Module<any, any, any, any, any>
export type AnyProvider<Value = any> = Provider<Value, any>
export type AnyProcedure = Procedure<any, any, any, any, any>
export type AnyTask = Task<any, any, any, any>
export type AnyEvent = Event<any, any, any>
export type AnyGuard = Guard<any>
export type AnyMiddleware = Middleware<any>

export type ApiPath = { procedure: AnyProcedure; name: string }

export type MiddlewareContext = {
  connection: BaseTransportConnection
  container: Container
  path: ApiPath
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

export type InferSchemaOutput<Schema> = Schema extends import('zod').ZodSchema
  ? import('zod').output<Schema>
  : Schema extends import('@sinclair/typebox').TSchema
    ? import('@sinclair/typebox').Static<Schema>
    : unknown

export type InferSchemaInput<Schema> = Schema extends import('zod').ZodSchema
  ? import('zod').input<Schema>
  : Schema extends import('@sinclair/typebox').TSchema
    ? import('@sinclair/typebox').Static<Schema>
    : unknown

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

type AppClientProcedures<
  ModuleName extends string,
  Module extends AnyModule,
  Prefix extends string = '',
  Procedures extends Module['procedures'] = Module['procedures'],
  ImportPrefix extends string = Prefix extends ''
    ? ModuleName
    : `${Prefix}/${ModuleName}`,
> = Merge<
  //@ts-expect-error
  keyof Module['imports'] extends never
    ? {}
    : UnionToIntersection<
        {
          [K in keyof Module['imports']]: {
            [P in keyof AppClientProcedures<
              // @ts-expect-error
              K,
              Module['imports'][K],
              ImportPrefix
            >]: // @ts-expect-error
            AppClientProcedures<K, Module['imports'][K], ImportPrefix>[P]
          }
        }[keyof Module['imports']]
      >,
  {
    [K in keyof Procedures as K extends string
      ? `${Prefix extends '' ? ModuleName : `${Prefix}/${ModuleName}`}/${K}`
      : never]: Procedures[K] extends AnyProcedure
      ? {
          input: InferSchemaOutput<Procedures[K]['_']['input']>
          output: Awaited<
            null extends Procedures[K]['_']['output']
              ? ReturnType<Procedures[K]['handler']>
              : InferSchemaOutput<Procedures[K]['_']['output']>
          >
        }
      : never
  }
>

type AppClientEvents<
  ModuleName extends string,
  Module extends AnyModule,
  Prefix extends string = '',
  ImportPrefix extends string = Prefix extends ''
    ? ModuleName
    : `${Prefix}/${ModuleName}`,
  Events extends Module['events'] = Module['events'],
> = Merge<
  //@ts-expect-error
  keyof Module['imports'] extends never
    ? { moduleName: ModuleName }
    : UnionToIntersection<
        {
          [K in keyof Module['imports']]: {
            [P in keyof AppClientEvents<
              //@ts-expect-error
              K,
              Module['imports'][K],
              ImportPrefix
              //@ts-expect-error
            >]: AppClientEvents<K, Module['imports'][K], ImportPrefix>[P]
          }
        }[keyof Module['imports']]
      >,
  {
    [K in keyof Events as K extends string
      ? `${Prefix extends '' ? ModuleName : `${Prefix}/${ModuleName}`}/${K}`
      : never]: Events[K]['_']['payload']
  }
>

export type AppClient<App extends AnyApplication> = {
  procedures: UnionToIntersection<
    {
      [K in keyof App['modules']]: {
        [P in keyof AppClientProcedures<
          //@ts-expect-error
          K,
          App['modules'][K]
          //@ts-expect-error
        >]: AppClientProcedures<K, App['modules'][K]>[P]
      }
    }[keyof App['modules']]
  >
  events: UnionToIntersection<
    {
      [K in keyof App['modules']]: {
        //@ts-expect-error
        [P in keyof AppClientEvents<K, App['modules'][K]>]: AppClientEvents<
          //@ts-expect-error
          K,
          App['modules'][K]
        >[P]
      }
    }[keyof App['modules']]
  >
}
