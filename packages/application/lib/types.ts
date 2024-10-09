import type { ApiBlobInterface } from '@nmtjs/common'

import type { Api } from './api.ts'
import type { Connection, ConnectionOptions } from './connection.ts'
import type { Hook, WorkerType } from './constants.ts'
import type { Container } from './container.ts'
import type { EventManager } from './events.ts'
import type { Format } from './format.ts'
import type { Hooks } from './hooks.ts'
import type { Logger } from './logger.ts'
import type { AnyBaseProcedure } from './procedure.ts'
import type { Registry } from './registry.ts'
import type { AnyService } from './service.ts'
import type { ServerUpStream } from './stream.ts'
import type { AnyTask, Task, TaskExecution } from './task.ts'

export type ClassConstructor<T> = new (...args: any[]) => T
export type Callback<T extends any[] = any[]> = (...args: T) => any
export type OmitFirstItem<T extends any[]> = T extends [any, ...infer U]
  ? U
  : []
export type ErrorClass = new (...args: any[]) => Error
export type Extra = Record<string, any>
export type Async<T> = T | Promise<T>

export type Command = (options: {
  args: string[]
  kwargs: Record<string, any>
}) => any

export interface HooksInterface {
  [Hook.BeforeInitialize]: () => any
  [Hook.AfterInitialize]: () => any
  [Hook.BeforeStart]: () => any
  [Hook.AfterStart]: () => any
  [Hook.BeforeStop]: () => any
  [Hook.AfterStop]: () => any
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

export type CallContext = Readonly<{
  connection: Connection
  container: Container
  procedure: AnyBaseProcedure
  service: AnyService
}>

export type UnionToIntersection<U> = (
  U extends any
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never

export type ExecuteFn = <
  T extends AnyTask,
  A extends T extends Task<any, any, infer Args> ? Args : never,
  R extends T extends Task<any, any, any, infer Result> ? Result : never,
>(
  task: T,
  ...args: A
) => TaskExecution<R>

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
  : T extends Date
    ? T
    : T extends ApiBlobInterface
      ? ServerUpStream
      : T extends object
        ? { [K in keyof T]: OutputType<T[K]> }
        : T

export type InputType<T> = T extends any[]
  ? Array<InputType<T[number]>>
  : T extends Date
    ? T
    : T extends ApiBlobInterface
      ? ServerUpStream
      : T extends object
        ? { [K in keyof T]: InputType<T[K]> }
        : T

/**
 * Slightly modified version of https://github.com/samchon/typia Primitive type. (TODO: make a PR maybe?)
 * Excludes keys with `never` types from object, and if a function is in array,
 * then it is stringified as `null`, just like V8's implementation of JSON.stringify does.
 */
export type JsonPrimitive<T> = Equal<T, JsonPrimitiveMain<T>> extends true
  ? T
  : JsonPrimitiveMain<T>

type Equal<X, Y> = X extends Y ? (Y extends X ? true : false) : false

type JsonPrimitiveMain<
  Instance,
  InArray extends boolean = false,
> = Instance extends [never]
  ? never // (special trick for jsonable | null) type
  : ValueOf<Instance> extends bigint
    ? never
    : ValueOf<Instance> extends boolean | number | string
      ? ValueOf<Instance>
      : Instance extends Function
        ? InArray extends true
          ? null
          : never
        : ValueOf<Instance> extends object
          ? Instance extends object
            ? Instance extends NativeClass
              ? {}
              : Instance extends IJsonable<infer Raw>
                ? ValueOf<Raw> extends object
                  ? Raw extends object
                    ? PrimitiveObject<Raw> // object would be primitified
                    : never // cannot be
                  : ValueOf<Raw> // atomic value
                : PrimitiveObject<Instance> // object would be primitified
            : never // cannot be
          : ValueOf<Instance>

type PrimitiveObject<Instance extends object> = Instance extends Array<infer T>
  ? IsTuple<Instance> extends true
    ? PrimitiveTuple<Instance>
    : JsonPrimitiveMain<T, true>[]
  : {
      -readonly [P in keyof Instance as JsonPrimitiveMain<
        Instance[P]
      > extends never
        ? never
        : P]: JsonPrimitiveMain<Instance[P]>
    }

type PrimitiveTuple<T extends readonly any[]> = T extends []
  ? []
  : T extends [infer F]
    ? [JsonPrimitiveMain<F, true>]
    : T extends [infer F, ...infer Rest extends readonly any[]]
      ? [JsonPrimitiveMain<F, true>, ...PrimitiveTuple<Rest>]
      : T extends [(infer F)?]
        ? [JsonPrimitiveMain<F, true>?]
        : T extends [(infer F)?, ...infer Rest extends readonly any[]]
          ? [JsonPrimitiveMain<F, true>?, ...PrimitiveTuple<Rest>]
          : []

type ValueOf<Instance> = IsValueOf<Instance, boolean> extends true
  ? boolean
  : IsValueOf<Instance, number> extends true
    ? number
    : IsValueOf<Instance, string> extends true
      ? string
      : Instance

type NativeClass =
  | Set<any>
  | Map<any, any>
  | WeakSet<any>
  | WeakMap<any, any>
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | BigUint64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigInt64Array
  | Float32Array
  | Float64Array
  | ArrayBuffer
  | SharedArrayBuffer
  | DataView

type IsTuple<T extends readonly any[] | { length: number }> = [T] extends [
  never,
]
  ? false
  : T extends readonly any[]
    ? number extends T['length']
      ? false
      : true
    : false

type IsValueOf<Instance, Object extends IValueOf<any>> = Instance extends Object
  ? Object extends IValueOf<infer U>
    ? Instance extends U
      ? false
      : true // not Primitive, but Object
    : false // cannot be
  : false

interface IValueOf<T> {
  valueOf(): T
}

interface IJsonable<T> {
  toJSON(): T
}
