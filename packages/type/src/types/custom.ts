import {
  any,
  type core,
  custom,
  overwrite,
  pipe,
  refine,
  type ZodMiniPipe,
  type ZodMiniType,
} from '@zod/mini'
import { BaseType, type SimpleZodType, type ZodType } from './base.ts'

export type CustomTransformFn<I, O> = (value: I) => O
export abstract class TransformType<
  Type,
  EncodedType extends SimpleZodType = ZodMiniType<Type, Type>,
  DecodedType extends ZodType = ZodMiniType<Type, Type>,
> extends BaseType<
  ZodMiniPipe<
    ZodMiniType<DecodedType['_zod']['output'], DecodedType['_zod']['input']>,
    EncodedType
  >,
  ZodMiniPipe<
    EncodedType,
    ZodMiniType<EncodedType['_zod']['output'], EncodedType['_zod']['input']>
  >
> {}

export class CustomType<
  Type,
  EncodedType extends SimpleZodType = ZodMiniType<Type, Type>,
  DecodedType extends ZodType = ZodMiniType<Type, Type>,
> extends TransformType<Type, EncodedType, DecodedType> {
  static factory<
    Type,
    EncodedType extends SimpleZodType = ZodMiniType<Type, Type>,
    DecodedType extends ZodType = ZodMiniType<Type, Type>,
  >({
    decode,
    encode,
    error,
    type = any() as unknown as EncodedType,
  }: {
    decode: CustomTransformFn<
      EncodedType['_zod']['input'],
      DecodedType['_zod']['output']
    >
    encode: CustomTransformFn<
      DecodedType['_zod']['input'],
      EncodedType['_zod']['output']
    >
    error?: string | core.$ZodErrorMap<core.$ZodIssueBase>
    type?: EncodedType
  }) {
    return new CustomType<Type, EncodedType, DecodedType>({
      encodedZodType: pipe(
        custom().check(
          refine((val) => typeof val !== 'undefined', { error, abort: true }),
          overwrite(encode),
        ),
        type,
      ),
      decodedZodType: pipe(
        type,
        custom().check(
          refine((val) => typeof val !== 'undefined', { error, abort: true }),
          overwrite(decode),
        ),
      ),
      params: { encode },
    })
  }
}
