import {
  any,
  type core,
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
  DecodedType extends ZodType = ZodMiniCustom<Type, Type>,
> extends BaseType<
  ZodMiniPipe<
    ZodMiniCustom<DecodedType['_zod']['output'], DecodedType['_zod']['input']>,
    EncodedType
  >,
  ZodMiniPipe<
    EncodedType,
    ZodMiniCustom<EncodedType['_zod']['output'], EncodedType['_zod']['input']>
  >
> {}

export class CustomType<
  Type,
  EncodedType extends SimpleZodType = ZodMiniAny,
  DecodedType extends ZodType = ZodMiniCustom<Type, Type>,
> extends TransformType<Type, EncodedType, DecodedType> {
  static factory<
    Type,
    EncodedType extends SimpleZodType = ZodMiniAny,
    DecodedType extends ZodType = ZodMiniCustom<Type, Type>,
  >({
    decode,
    encode,
    error,
    type = any() as unknown as EncodedType,
  }: {
    decode: CustomTypeDecode<
      EncodedType['_zod']['input'],
      DecodedType['_zod']['output']
    >
    encode: CustomTypeEncode<
      DecodedType['_zod']['input'],
      EncodedType['_zod']['output']
    >
    error?: string | core.$ZodErrorMap<core.$ZodIssueBase>
    type?: EncodedType
  }) {
    return new CustomType<Type, EncodedType, DecodedType>({
      encodedZodType: pipe(custom().check(overwrite(encode)), type),
      decodedZodType: pipe(
        type,
        custom(undefined, { error }).check(overwrite(decode)),
      ),
      params: { encode },
    })
  }
}
