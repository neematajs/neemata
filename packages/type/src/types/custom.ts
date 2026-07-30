import type { MaybePromise } from '@nmtjs/common'
import type { core, ZodMiniCodec, ZodMiniType } from 'zod/mini'
import { NEVER, any, codec, invertCodec, superRefine } from 'zod/mini'

import type { SimpleZodType, ZodType } from './base.ts'
import { BaseType } from './base.ts'

export type CustomTransformFn<I, O> = (value: I) => O

type CustomValidation<Type extends ZodType> = (
  value: Type['_zod']['output'],
  payload: core.$RefinementCtx<Type['_zod']['output']>,
) => MaybePromise<void>

export abstract class TransformType<
  Type,
  EncodeType extends SimpleZodType = ZodMiniType<Type, Type>,
  DecodeType extends ZodType = ZodMiniType<Type, Type>,
> extends BaseType<
  ZodMiniCodec<DecodeType, EncodeType>,
  ZodMiniCodec<EncodeType, DecodeType>
> {}

const addIssue = (
  payload: core.ParsePayload,
  value: unknown,
  issue: string | core.$ZodSuperRefineIssue,
) => {
  payload.issues.push(
    (typeof issue === 'string'
      ? { code: 'custom', message: issue, input: value }
      : {
          ...issue,
          code: issue.code ?? 'custom',
          input: issue.input ?? value,
        }) as core.$ZodRawIssue,
  )
}

const refinementContext = <T>(
  payload: core.ParsePayload<T>,
): core.$RefinementCtx<T> => {
  return Object.assign(payload, {
    addIssue: (issue: string | core.$ZodSuperRefineIssue) =>
      addIssue(payload, payload.value, issue),
  })
}

const addTransformIssue = (
  payload: core.ParsePayload,
  value: unknown,
  error: string | core.$ZodErrorMap<core.$ZodIssueBase> | undefined,
  cause: unknown,
) => {
  const issue = {
    code: 'custom',
    input: value,
  } as const satisfies core.$ZodRawIssue
  const mappedError = typeof error === 'function' ? error(issue) : undefined
  const message =
    typeof error === 'string'
      ? error
      : typeof mappedError === 'string'
        ? mappedError
        : (mappedError?.message ??
          (cause instanceof Error ? cause.message : 'Invalid input'))

  payload.issues.push({ ...issue, message })
}

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
    decodedType = any() as unknown as DecodeType,
    prototype,
  }: {
    decode: CustomTransformFn<
      EncodeType['_zod']['output'],
      DecodeType['_zod']['input']
    >
    encode: CustomTransformFn<
      DecodeType['_zod']['output'],
      EncodeType['_zod']['input']
    >
    validation?:
      | CustomValidation<DecodeType>
      | {
          encode?: CustomValidation<DecodeType>
          decode?: CustomValidation<DecodeType>
        }
    error?: string | core.$ZodErrorMap<core.$ZodIssueBase>
    /** Schema for the encoded/wire representation. */
    type?: EncodeType
    /** Schema for the decoded/runtime representation. */
    decodedType?: DecodeType
    prototype?: object
  }): CustomType<Type, EncodeType, DecodeType> {
    const _validation = validation
      ? typeof validation === 'function'
        ? { encode: validation, decode: validation }
        : validation
      : undefined

    const decodeZodType = codec(type, decodedType, {
      decode: (value, payload) => {
        try {
          return decode(value)
        } catch (cause) {
          addTransformIssue(payload, value, error, cause)
          return NEVER
        }
      },
      encode: (value, payload) => {
        const transform = () => {
          if (payload.issues.length > 0) return NEVER

          try {
            return encode(value)
          } catch (cause) {
            addTransformIssue(payload, value, error, cause)
            return NEVER
          }
        }
        const result = _validation?.encode?.(value, refinementContext(payload))

        return result instanceof Promise ? result.then(transform) : transform()
      },
    })
    const encodeZodType = invertCodec(decodeZodType)

    if (_validation?.decode) {
      decodeZodType.check(superRefine(_validation.decode))
    }

    const instance = new CustomType<Type, EncodeType, DecodeType>({
      encodeZodType,
      decodeZodType,
    })

    if (prototype) Object.setPrototypeOf(instance, prototype)

    return instance
  }
}

export const custom = CustomType.factory
