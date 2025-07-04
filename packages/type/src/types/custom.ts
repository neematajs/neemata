import * as zod from 'zod/v4-mini'
import { BaseType, type SimpleZodType, type ZodType } from './base.ts'

export type CustomTransformFn<I, O> = (value: I) => O
export abstract class TransformType<
  Type,
  EncodedType extends SimpleZodType = zod.ZodMiniType<Type, Type>,
  DecodedType extends ZodType = zod.ZodMiniType<Type, Type>,
> extends BaseType<
  zod.ZodMiniPipe<
    zod.ZodMiniType<
      DecodedType['_zod']['output'],
      DecodedType['_zod']['input']
    >,
    EncodedType
  >,
  zod.ZodMiniPipe<
    EncodedType,
    zod.ZodMiniType<DecodedType['_zod']['output'], DecodedType['_zod']['input']>
  >
> {}

export class CustomType<
  Type,
  EncodedType extends SimpleZodType = zod.ZodMiniType<Type, Type>,
  DecodedType extends ZodType = zod.ZodMiniType<Type, Type>,
> extends TransformType<Type, EncodedType, DecodedType> {
  static factory<
    Type,
    EncodedType extends SimpleZodType = zod.ZodMiniType<Type, Type>,
    DecodedType extends ZodType = zod.ZodMiniType<Type, Type>,
  >({
    decode,
    encode,
    error,
    type = zod.any() as unknown as EncodedType,
  }: {
    decode: CustomTransformFn<
      EncodedType['_zod']['input'],
      DecodedType['_zod']['output']
    >
    encode: CustomTransformFn<
      DecodedType['_zod']['input'],
      EncodedType['_zod']['output']
    >
    error?: string | zod.core.$ZodErrorMap<zod.core.$ZodIssueBase>
    type?: EncodedType
  }) {
    return new CustomType<Type, EncodedType, DecodedType>({
      encodedZodType: zod.pipe(
        zod.custom().check(
          zod.refine((val) => typeof val !== 'undefined', {
            error,
            abort: true,
          }),
          zod.overwrite(encode),
        ),
        type,
      ),
      // @ts-expect-error
      decodedZodType: zod.pipe(
        type,
        // @ts-expect-error
        zod
          .custom()
          .check(
            zod.refine((val) => typeof val !== 'undefined', {
              error,
              abort: true,
            }),
            zod.overwrite(decode),
          ),
      ),
      params: { encode },
    })
  }
}

export const custom = CustomType.factory
