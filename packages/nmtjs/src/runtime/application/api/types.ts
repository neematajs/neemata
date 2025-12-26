import type { Container } from '@nmtjs/core'
import type { GatewayConnection } from '@nmtjs/gateway'

import type { AnyProcedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'

export type ApiCallContext = Readonly<{
  connection: GatewayConnection
  container: Container
  path: AnyRouter[]
  procedure: AnyProcedure
}>

export type JsonPrimitive<T> =
  Equal<T, JsonPrimitiveMain<T>> extends true ? T : JsonPrimitiveMain<T>

type Equal<X, Y> = X extends Y ? (Y extends X ? true : false) : false

type JsonPrimitiveMain<
  Instance,
  InArray extends boolean = false,
> = Instance extends [never]
  ? never
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
                    ? PrimitiveObject<Raw>
                    : never
                  : ValueOf<Raw>
                : PrimitiveObject<Instance>
            : never
          : ValueOf<Instance>

type PrimitiveObject<Instance extends object> =
  Instance extends Array<infer T>
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

type ValueOf<Instance> =
  IsValueOf<Instance, boolean> extends true
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
      : true
    : false
  : false

interface IValueOf<T> {
  valueOf(): T
}

interface IJsonable<T> {
  toJSON(): T
}
