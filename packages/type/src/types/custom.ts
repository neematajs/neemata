import {
  type TAny,
  type TTransform,
  type TUnsafe,
  Type,
} from '@sinclair/typebox'
import { BaseType, type ConstantType } from './base.ts'

export type CustomTypeDecode<T> = (value: any) => T
export type CustomTypeEncode<T> = (value: T) => any

export abstract class TransformType<T, S = TAny> extends BaseType<
  TTransform<TUnsafe<S>, T>
> {
  _!: ConstantType<this['schema']>
}

export class CustomType<T, S = TAny> extends TransformType<T, S> {
  static factory<T, S = TAny>(
    decode: CustomTypeDecode<T>,
    encode: CustomTypeEncode<T>,
    schema = Type.Any() as unknown as TUnsafe<S>,
  ) {
    return new CustomType<T, S>(
      Type.Transform(schema as unknown as TUnsafe<S>)
        .Decode(decode)
        .Encode(encode),
      {},
      { encode } as any,
    )
  }
}
