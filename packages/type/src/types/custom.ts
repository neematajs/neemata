import {
  any,
  custom,
  overwrite,
  pipe,
  type ZodMiniAny,
  type ZodMiniCustom,
  type ZodMiniPipe,
} from '@zod/mini'
import { BaseType, type SimpleZodType, type ZodType } from './base.ts'

export type CustomTypeDecode<I, O> = (value: I) => O
export type CustomTypeEncode<I, O> = (value: I) => O

export abstract class TransformType<
  Type,
  EncodedType extends SimpleZodType = ZodMiniAny,
  DecodedType extends ZodType = ZodMiniCustom<Type>,
> extends BaseType<EncodedType, DecodedType> {}

export class CustomType<
  Type,
  EncodedType extends SimpleZodType = ZodMiniAny,
  DecodedType extends ZodType = ZodMiniCustom<Type, Type>,
> extends BaseType<
  ZodMiniPipe<DecodedType, EncodedType>,
  ZodMiniPipe<EncodedType, DecodedType>
> {
  static factory<
    Type,
    EncodedType extends SimpleZodType = ZodMiniAny,
    DecodedType extends ZodType = ZodMiniCustom<Type>,
  >(
    decode: CustomTypeDecode<
      EncodedType['_zod']['output'],
      DecodedType['_zod']['output']
    >,
    encode: CustomTypeEncode<
      DecodedType['_zod']['output'],
      EncodedType['_zod']['output']
    >,
    type: EncodedType = any() as unknown as EncodedType,
  ) {
    return new CustomType<Type, EncodedType, DecodedType>({
      //@ts-expect-error
      encodedZodType: pipe(custom().check(overwrite(encode)), type),
      //@ts-expect-error
      decodedZodType: pipe(type, custom().check(overwrite(decode))),
      params: { encode },
    })
  }
}
