import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'
import type { ZodMiniType } from 'zod/mini'
import type { ToJSONSchemaParams } from 'zod/v4/core'
import { core, toJSONSchema } from 'zod/mini'

import type { MetadataRegistry } from './types/_metadata.ts'
import type { BaseType } from './types/_type.ts'

export namespace standard {
  export type Schema<T extends ZodMiniType> = StandardSchemaV1<
    T['_zod']['input'],
    T['_zod']['output']
  > &
    StandardJSONSchemaV1<T['_zod']['input'], T['_zod']['output']>

  export type Props<T extends ZodMiniType> = StandardSchemaV1.Props<
    T['_zod']['input'],
    T['_zod']['output']
  > &
    StandardJSONSchemaV1.Props<T['_zod']['input'], T['_zod']['output']>

  export const decode = <T extends BaseType>(
    type: T,
    registry: MetadataRegistry,
  ): Schema<T['decodeZodType']> =>
    create(type.decodeZodType, (value) => type.decode(value), registry)

  export const encode = <T extends BaseType>(
    type: T,
    registry: MetadataRegistry,
  ): Schema<T['encodeZodType']> =>
    create(type.encodeZodType, (value) => type.encode(value), registry)

  const create = <T extends ZodMiniType>(
    zodType: T,
    parse: (value: unknown) => T['_zod']['output'],
    registry: MetadataRegistry,
  ): Schema<T> => {
    const jsonSchema =
      (io: 'input' | 'output') =>
      ({ target, libraryOptions }: StandardJSONSchemaV1.Options) => {
        const { json = {} } = (libraryOptions || {}) as {
          json?: ToJSONSchemaParams
        }
        const { cycles = 'throw', reused = 'inline' } = json
        return toJSONSchema(zodType, {
          target,
          io,
          cycles,
          reused,
          unrepresentable: 'any',
          metadata: registry,
        })
      }

    return Object.freeze({
      '~standard': Object.freeze({
        vendor: 'neemata-type',
        version: 1,
        validate: (value) => {
          try {
            return { value: parse(value) }
          } catch (e) {
            if (e instanceof core.$ZodError) {
              const issues: StandardSchemaV1.Issue[] = e.issues.map(
                (issue) => ({
                  message: issue.message,
                  path: issue.path.length > 0 ? issue.path : undefined,
                }),
              )
              return { issues }
            }
            throw e
          }
        },
        jsonSchema: {
          input: jsonSchema('input'),
          output: jsonSchema('output'),
        },
      } satisfies Props<T>),
    })
  }
}
