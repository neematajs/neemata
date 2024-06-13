import type {
  Stream as ServerStream,
  StreamResponse as ServerStreamResponse,
  Subscription as ServerSubscription,
} from '@neematajs/application'
import {
  type AppClientInterface,
  BaseClientFormat,
  type Subscription as ClientSubscription,
  type DownStream,
  type StreamMetadata,
  type TypeProvider,
  UpStream,
  concat,
  decodeText,
  encodeNumber,
  encodeText,
} from '@neematajs/common'
import { serializeStreamId } from './common'

export class JsonFormat extends BaseClientFormat {
  mime = 'application/json'

  encode(
    data: any,
    replacer?: (this: any, key: string, value: any) => any,
  ): ArrayBuffer {
    return encodeText(JSON.stringify(data, replacer))
  }

  decode(data: ArrayBuffer): any {
    return JSON.parse(decodeText(data))
  }

  encodeRpc(callId: number, procedure: string, payload: any): ArrayBuffer {
    const streams: Record<number, StreamMetadata> = {}
    const replacer = (key: string, value: any) => {
      if (value instanceof UpStream) {
        streams[value.id] = value.metadata
        return serializeStreamId(value)
      }
      return value
    }
    const rpcPayload = this.encode([callId, procedure, payload], replacer)
    const streamsData = this.encode(streams)
    const streamDataLength = encodeNumber(streamsData.byteLength, 'Uint32')
    return concat(streamDataLength, streamsData, rpcPayload)
  }
}

export interface JsonFormatTypeProvider extends TypeProvider {
  output: this['input'] extends AppClientInterface
    ? JsonFormatAppClient<this['input']>
    : unknown
}

type JsonFormatAppClient<T extends AppClientInterface> = {
  procedures: {
    [P in keyof T['procedures']]: {
      output: ResolveApiOutput<T['procedures'][P]['output']>
      input: ResolveApiInput<T['procedures'][P]['input']>
    }
  }
  events: {
    [E in keyof T['events']]: JsonPrimitive<T['events'][E]>
  }
}

type ResolveApiInput<Input> = Input extends ServerStream
  ? UpStream
  : Input extends object
    ? {
        [K in keyof Input]: ResolveApiInput<Input[K]>
      }
    : JsonPrimitive<Input>

type ResolveApiOutput<Output> = Output extends ServerStreamResponse
  ? {
      payload: Output['payload']
      stream: DownStream<
        Output['chunk'] extends ArrayBuffer ? ArrayBuffer : Output['chunk']
      >['interface']
    }
  : Output extends ServerSubscription
    ? ClientSubscription<Output['_']['event']['_']['payload']>
    : JsonPrimitive<Output>

/**
 * Slightly modified version of https://github.com/samchon/typia Primitive type. (TODO: make a PR maybe?)
 * Excludes keys with `never` types from object, and if a function is in array,
 * then it is stringified as `null`, just like V8's implementation of JSON.stringify does.
 */
type JsonPrimitive<T> = Equal<T, JsonPrimitiveMain<T>> extends true
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
      [P in keyof Instance as JsonPrimitiveMain<Instance[P]> extends never
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

type ValueOf<Instance> = IsValueOf<Instance, Boolean> extends true
  ? boolean
  : IsValueOf<Instance, Number> extends true
    ? number
    : IsValueOf<Instance, String> extends true
      ? string
      : Instance

type NativeClass =
  | Blob
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
