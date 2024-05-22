import { Decoder, Encoder, ExtensionCodec, encode } from '@msgpack/msgpack'
import type {
  Stream as ServerStream,
  StreamResponse as ServerStreamResponse,
  Subscription as ServerSubscription,
} from '@neematajs/application'
import {
  type AppClientInterface,
  type Subscription as ClientSubscription,
  UpStream,
} from '@neematajs/common'
import { BaseClientFormat } from '@neematajs/common'
import { STREAM_EXT_TYPE, registerJsonLikeExtension } from './common'

const extensionCodec = new ExtensionCodec<any>()

extensionCodec.register({
  type: STREAM_EXT_TYPE,
  encode: (value, context) => {
    if (value instanceof UpStream)
      return encode([value.id, value.metadata], {
        extensionCodec,
        useBigInt64: true,
        context,
      })
    return null
  },
  decode: () => null, // client does not decode up streams
})

const encoder = new Encoder({ extensionCodec, useBigInt64: true })
const decoder = new Decoder({ extensionCodec, useBigInt64: true })

registerJsonLikeExtension(extensionCodec)

export class MessagepackFormat extends BaseClientFormat {
  mime = 'application/x-msgpack'

  encode(data: any): ArrayBuffer {
    return encoder.encode(data).buffer
  }

  decode(data: ArrayBuffer): any {
    return decoder.decode(new Uint8Array(data))
  }

  encodeRpc(callId: number, procedure: string, payload: any): ArrayBuffer {
    return this.encode([callId, procedure, payload])
  }
}

export type MessagepackFormatAppClient<T extends AppClientInterface> = {
  procedures: {
    [P in keyof T['procedures']]: {
      output: ResolveApiOutput<T['procedures'][P]['output']>
      input: ResolveApiInput<T['procedures'][P]['input']>
    }
  }
  events: {
    [E in keyof T['events']]: MessagepackPrimitive<T['events'][E]>
  }
}

type ResolveApiInput<Input> = Input extends ServerStream
  ? UpStream
  : Input extends object
    ? {
        [K in keyof Input]: ResolveApiInput<Input[K]>
      }
    : MessagepackPrimitive<Input>

type ResolveApiOutput<Output> = Output extends ServerStreamResponse
  ? {
      payload: Output['payload']
      stream: import('@neematajs/common').DownStream<
        Output['chunk'] extends ArrayBuffer ? ArrayBuffer : Output['chunk']
      >['interface']
    }
  : Output extends ServerSubscription
    ? ClientSubscription<Output['_']['event']['_']['payload']>
    : MessagepackPrimitive<Output>

type MessagepackPrimitive<T> = Equal<
  T,
  MessagepackPrimitiveMain<T>
> extends true
  ? T
  : MessagepackPrimitiveMain<T>

type Equal<X, Y> = X extends Y ? (Y extends X ? true : false) : false

type MessagepackPrimitiveMain<Instance> = Instance extends [never]
  ? never // (special trick for jsonable | null) type
  : ValueOf<Instance> extends bigint
    ? never
    : ValueOf<Instance> extends boolean | number | string
      ? ValueOf<Instance>
      : Instance extends Function
        ? never
        : ValueOf<Instance> extends object
          ? Instance extends object
            ? Instance extends NativeClass
              ? {}
              : Instance extends Date
                ? Date
                : Instance extends BinaryClass
                  ? Uint8Array
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
    : MessagepackPrimitiveMain<T>[]
  : {
      [P in keyof Instance as MessagepackPrimitiveMain<
        Instance[P]
      > extends never
        ? never
        : P]: MessagepackPrimitiveMain<Instance[P]>
    }

type PrimitiveTuple<T extends readonly any[]> = T extends []
  ? []
  : T extends [infer F]
    ? [MessagepackPrimitiveMain<F>]
    : T extends [infer F, ...infer Rest extends readonly any[]]
      ? [MessagepackPrimitiveMain<F>, ...PrimitiveTuple<Rest>]
      : T extends [(infer F)?]
        ? [MessagepackPrimitiveMain<F>?]
        : T extends [(infer F)?, ...infer Rest extends readonly any[]]
          ? [MessagepackPrimitiveMain<F>?, ...PrimitiveTuple<Rest>]
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

type BinaryClass =
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
