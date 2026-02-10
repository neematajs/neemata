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

  export type SchemaProps<T extends ZodMiniType> = StandardSchemaV1.Props<
    T['_zod']['input'],
    T['_zod']['output']
  > &
    StandardJSONSchemaV1.Props<T['_zod']['input'], T['_zod']['output']>

  export type JSONProps<T extends ZodMiniType> = StandardJSONSchemaV1.Props<
    T['_zod']['input'],
    T['_zod']['output']
  >

  export type Props<T extends ZodMiniType> = SchemaProps<T> & JSONProps<T>

  export const decode = <T extends BaseType>(
    type: T,
    registry: MetadataRegistry,
  ): Schema<T['decodeZodType']> => {
    return Object.freeze({
      '~standard': Object.freeze({
        vendor: 'neemata-type',
        version: 1,
        validate: (value, options = {}) => {
          try {
            return { value: type.decode(value) }
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
          input: ({ target, libraryOptions }) => {
            const { json = {} } = (libraryOptions || {}) as {
              json: ToJSONSchemaParams
            }
            const { cycles = 'throw', reused = 'inline' } = json
            return toJSONSchema(type.decodeZodType, {
              target,
              io: 'input',
              cycles,
              reused,
              unrepresentable: 'any',
              metadata: registry,
            })
          },
          output: ({ target, libraryOptions }) => {
            const { json = {} } = (libraryOptions || {}) as {
              json: ToJSONSchemaParams
            }
            const { cycles = 'throw', reused = 'inline' } = json
            return toJSONSchema(type.decodeZodType, {
              target,
              io: 'output',
              cycles,
              reused,
              unrepresentable: 'any',
              metadata: registry,
            })
          },
        },
      } satisfies Props<T['decodeZodType']>),
    })
  }

  export const encode = <T extends BaseType>(
    type: T,
    registry: MetadataRegistry,
  ): Schema<T['encodeZodType']> => {
    return Object.freeze({
      '~standard': Object.freeze({
        vendor: 'neemata-type',
        version: 1,
        validate: (value) => {
          try {
            return { value: type.encode(value) }
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
          input: ({ target, libraryOptions }) => {
            const { json = {} } = (libraryOptions || {}) as {
              json: ToJSONSchemaParams
            }
            const { cycles = 'throw', reused = 'inline' } = json
            return toJSONSchema(type.encodeZodType, {
              target,
              io: 'input',
              cycles,
              reused,
              unrepresentable: 'any',
              metadata: registry,
            })
          },
          output: ({ target, libraryOptions }) => {
            const { json = {} } = (libraryOptions || {}) as {
              json: ToJSONSchemaParams
            }
            const { cycles = 'throw', reused = 'inline' } = json
            return toJSONSchema(type.encodeZodType, {
              target,
              io: 'output',
              cycles,
              reused,
              unrepresentable: 'any',
            })
          },
        },
      } satisfies Props<T['encodeZodType']>),
    })
  }
}
