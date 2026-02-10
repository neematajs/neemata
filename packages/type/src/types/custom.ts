import type { MaybePromise } from '@nmtjs/common'
import type { core, ZodMiniType } from 'zod/mini'
import {
  any,
  overwrite,
  pipe,
  refine,
  superRefine,
  custom as zodCustom,
} from 'zod/mini'

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
    validation,
    error,
    type = any() as unknown as EncodeType,
    prototype,
  }: {
    decode: CustomTransformFn<
      EncodeType['_zod']['input'],
      DecodeType['_zod']['output']
    >
    encode: CustomTransformFn<
      DecodeType['_zod']['input'],
      EncodeType['_zod']['output']
    >
    validation?:
      | ((
          value: EncodeType['_zod']['input'] | DecodeType['_zod']['output'],

          payload: core.$RefinementCtx<
            EncodeType['_zod']['output'] | DecodeType['_zod']['output']
          >,
        ) => MaybePromise<void>)
      | {
          encode?: (
            value: EncodeType['_zod']['input'],
            payload: core.$RefinementCtx<EncodeType['_zod']['output']>,
          ) => MaybePromise<void>
          decode?: (
            value: DecodeType['_zod']['output'],
            payload: core.$RefinementCtx<DecodeType['_zod']['output']>,
          ) => MaybePromise<void>
        }
    error?: string | core.$ZodErrorMap<core.$ZodIssueBase>
    type?: EncodeType
    prototype?: object
  }): CustomType<Type, EncodeType, DecodeType> {
    const _validation = validation
      ? typeof validation === 'function'
        ? { encode: validation, decode: validation }
        : validation
      : undefined

    const instance = new CustomType<Type, EncodeType, DecodeType>({
      encodeZodType: pipe(
        zodCustom().check(
          ...[
            refine((val) => typeof val !== 'undefined', { abort: true }),
            _validation?.encode ? superRefine(_validation.encode) : undefined,
            overwrite(encode),
          ].filter((v) => !!v),
        ),
        type,
      ),
      decodeZodType: pipe(
        type,
        // @ts-expect-error
        zodCustom().check(
          ...[
            refine((val) => typeof val !== 'undefined', { abort: true }),
            overwrite(decode),
            _validation?.decode ? superRefine(_validation.decode) : undefined,
          ].filter((v) => !!v),
        ),
      ),
      params: { encode },
    })

    if (prototype) Object.setPrototypeOf(instance, prototype)

    return instance
  }
}

export const custom = CustomType.factory
