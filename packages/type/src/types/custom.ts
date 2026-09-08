import type { MaybePromise } from '@nmtjs/common'
import type { core, ZodMiniCodec, ZodMiniType } from 'zod/mini'
import { NEVER, codec, invertCodec, superRefine } from 'zod/mini'

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
  ZodMiniCodec<EncodeType, DecodeType>,
  Record<string, never>,
  DecodeType
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
    prototype,
  }: {
    decode: {
      /** Runtime schema validated after decoding and by .parse(). */
      type: DecodeType
      transform: CustomTransformFn<
        EncodeType['_zod']['output'],
        DecodeType['_zod']['input']
      >
    }
    encode: {
      /** Wire schema validated after encoding and before decoding. */
      type: EncodeType
      transform: CustomTransformFn<
        DecodeType['_zod']['output'],
        EncodeType['_zod']['input']
      >
    }
    validation?:
      | CustomValidation<DecodeType>
      | {
          runtime?: CustomValidation<DecodeType>
          encode?: CustomValidation<DecodeType>
          decode?: CustomValidation<DecodeType>
        }
    error?: string | core.$ZodErrorMap<core.$ZodIssueBase>
    prototype?: object
  }): CustomType<Type, EncodeType, DecodeType> {
    if (!decode?.type) throw new TypeError('Custom types require decode.type')
    if (!encode?.type) throw new TypeError('Custom types require encode.type')
    const shared =
      typeof validation === 'function' ? validation : validation?.runtime
    const directional = typeof validation === 'object' ? validation : undefined
    // Runtime constraints run on every path; transport-specific checks stay on their direction.
    const runtimeZodType: DecodeType = shared
      ? decode.type.check(superRefine(shared))
      : decode.type

    const baseDecodeZodType = codec(encode.type, runtimeZodType, {
      decode: (value, payload) => {
        try {
          return decode.transform(value)
        } catch (cause) {
          addTransformIssue(payload, value, error, cause)
          return NEVER
        }
      },
      encode: (value, payload) => {
        const transform = () => {
          if (payload.issues.length > 0) return NEVER

          try {
            return encode.transform(value)
          } catch (cause) {
            addTransformIssue(payload, value, error, cause)
            return NEVER
          }
        }
        const result = directional?.encode?.(value, refinementContext(payload))

        return result instanceof Promise ? result.then(transform) : transform()
      },
    })
    const encodeZodType = invertCodec(baseDecodeZodType)
    const decodeZodType = directional?.decode
      ? baseDecodeZodType.check(superRefine(directional.decode))
      : baseDecodeZodType

    const instance = new CustomType<Type, EncodeType, DecodeType>({
      encodeZodType,
      decodeZodType,
      runtimeZodType,
    })

    if (prototype) Object.setPrototypeOf(instance, prototype)

    return instance
  }
}

export const custom = CustomType.factory
