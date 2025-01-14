import {
  type TAny,
  type TSchema,
  type TTransform,
  Type,
} from '@sinclair/typebox'
import type { StaticInputDecode, StaticOutputDecode } from '../inference.ts'
import { BaseType } from './base.ts'

export type CustomTypeDecode<T> = (value: any) => T
export type CustomTypeEncode<T> = (value: T) => any

export abstract class TransformType<
  T,
  S extends TSchema = TAny,
> extends BaseType<TTransform<S, T>, {}, StaticInputDecode<TTransform<S, T>>> {}

export class CustomType<T, S extends TSchema = TAny> extends TransformType<
  T,
  S
> {
  static factory<T, S extends TSchema = TAny>(
    decode: CustomTypeDecode<T>,
    encode: CustomTypeEncode<T>,
    schema: S = Type.Any() as S,
  ) {
    return new CustomType<T, S>(
      Type.Transform(schema).Decode(decode).Encode(encode),
      {},
      { encode } as any,
    )
  }
}
