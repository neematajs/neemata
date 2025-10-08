import type { core, ZodMiniType } from 'zod/mini'
import { any, overwrite, pipe, refine, custom as zodCustom } from 'zod/mini'

import type { SimpleZodType, ZodType } from './base.ts'
import { BaseType } from './base.ts'

export type CustomTransformFn<I, O> = (value: I) => O
export abstract class TransformType<
  Type,
  EncodeType extends SimpleZodType = ZodMiniType<Type, Type>,
  DecodeType extends ZodType = ZodMiniType<Type, Type>,
> extends BaseType<
  ZodMiniType<EncodeType['_zod']['output'], DecodeType['_zod']['input']>,
  ZodMiniType<DecodeType['_zod']['output'], EncodeType['_zod']['input']>
> {}

export class CustomType<
  Type,
  EncodeType extends SimpleZodType = ZodMiniType<Type, Type>,
  DecodeType extends ZodType = ZodMiniType<Type, Type>,
> extends TransformType<Type, EncodeType, DecodeType> {
  static factory<
    Type,
    EncodeType extends SimpleZodType = ZodMiniType<Type, Type>,
    DecodeType extends ZodType = ZodMiniType<Type, Type>,
  >({
    decode,
    encode,
    error,
    type = any() as unknown as EncodeType,
  }: {
    decode: CustomTransformFn<
      EncodeType['_zod']['input'],
      DecodeType['_zod']['output']
    >
    encode: CustomTransformFn<
      DecodeType['_zod']['input'],
      EncodeType['_zod']['output']
    >
    error?: string | core.$ZodErrorMap<core.$ZodIssueBase>
    type?: EncodeType
  }) {
    return new CustomType<Type, EncodeType, DecodeType>({
      encodeZodType: pipe(
        zodCustom().check(
          refine((val) => typeof val !== 'undefined', { error, abort: true }),
          overwrite(encode),
        ),
        type,
      ),
      decodeZodType: pipe(
        type,
        // @ts-expect-error
        zodCustom().check(
          refine((val) => typeof val !== 'undefined', { error, abort: true }),
          overwrite(decode),
        ),
      ),
      params: { encode },
    })
  }
}

export const custom = CustomType.factory
