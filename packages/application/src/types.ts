import type { Container, Hooks, Logger } from '@nmtjs/core'
import type {
  ProtocolBlob,
  ProtocolBlobInterface,
} from '@nmtjs/protocol/common'
import type {
  Connection,
  Format,
  Protocol,
  ProtocolClientStream,
} from '@nmtjs/protocol/server'
import type { Api } from './api.ts'
import type { WorkerType } from './enums.ts'
import type { AnyNamespace } from './namespace.ts'
import type { AnyBaseProcedure } from './procedure.ts'
import type { ApplicationRegistry } from './registry.ts'
import type { AnyTask, BaseTaskExecutor, Task, TaskExecution } from './task.ts'

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

export interface ApplicationPluginContext {
  readonly type: WorkerType
  readonly api: Api
  readonly format: Format
  readonly container: Container
  readonly logger: Logger
  readonly registry: ApplicationRegistry
  readonly hooks: Hooks
  readonly protocol: Protocol
}

export type ApiCallContext = Readonly<{
  connection: Connection
  container: Container
  namespace: AnyNamespace
  procedure: AnyBaseProcedure
}>

export type ExecuteFn = <
  T extends AnyTask,
  A extends T extends Task<any, any, infer Args> ? Args : never,
  R extends T extends Task<any, any, any, infer Result> ? Result : never,
>(
  task: T,
  ...args: A
) => TaskExecution<R>

export type OutputType<T> = T extends any[]
  ? Array<OutputType<T[number]>>
  : T extends Date
    ? T
    : T extends ProtocolBlobInterface
      ? ProtocolBlob
      : T extends object
        ? { [K in keyof T]: OutputType<T[K]> }
        : T

export type InputType<T> = T extends any[]
  ? Array<InputType<T[number]>>
  : T extends Date
    ? T
    : T extends ProtocolBlobInterface
      ? ProtocolClientStream
      : T extends object
        ? { [K in keyof T]: InputType<T[K]> }
        : T

export type ApplicationWorkerOptions = {
  isServer: boolean
  workerType: WorkerType
  id: number
  workerOptions: any
  tasksRunner?: BaseTaskExecutor
}

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
