import type { Schema as CommonSchema, SchemaIssue } from '@nmtjs/common/schema'
import type { ZodMiniType } from 'zod/mini'
import type { ToJSONSchemaParams } from 'zod/v4/core'
import { core, toJSONSchema } from 'zod/mini'

import type { MetadataRegistry } from './types/_metadata.ts'

export namespace standard {
  /** Neemata's callable Zod-backed implementation of a Standard Schema. */
  export type Schema<T extends ZodMiniType> = CommonSchema.WithJSONSchema<
    T['_zod']['input'],
    T['_zod']['output']
  > &
    ((
      value: unknown,
      context?: core.ParseContext<core.$ZodIssue>,
    ) => T['_zod']['output'])

  export type Props<T extends ZodMiniType> = Schema<T>['~standard']

  export function create<T extends ZodMiniType>(
    zodType: T,
    registry: MetadataRegistry,
    jsonTypes: { input?: ZodMiniType; output?: ZodMiniType } = {},
  ): Schema<T> {
    const schema = Object.assign(
      (value: unknown, context: core.ParseContext<core.$ZodIssue> = {}) =>
        zodType.parse(value, context),
      {
        '~standard': Object.freeze({
          vendor: 'neemata-type',
          version: 1,
          validate: (value: unknown) => validate(zodType, value),
          jsonSchema: Object.freeze({
            input: (options) =>
              toJSON(jsonTypes.input ?? zodType, registry, 'input', options),
            output: (options) =>
              toJSON(jsonTypes.output ?? zodType, registry, 'output', options),
          }),
        } satisfies Props<T>),
      },
    )

    return Object.freeze(schema)
  }
}

function validate<T extends ZodMiniType>(zodType: T, value: unknown) {
  try {
    return { value: zodType.parse(value) }
  } catch (error) {
    if (error instanceof core.$ZodAsyncError) {
      return zodType.parseAsync(value).then(
        (output) => ({ value: output }),
        (asyncError: unknown) => {
          if (asyncError instanceof core.$ZodError) {
            return { issues: toIssues(asyncError) }
          }
          throw asyncError
        },
      )
    }
    if (error instanceof core.$ZodError) return { issues: toIssues(error) }
    throw error
  }
}

function toIssues(error: core.$ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({
    message: issue.message,
    path: issue.path.length > 0 ? issue.path : undefined,
  }))
}

function toJSON<T extends ZodMiniType>(
  zodType: T,
  registry: MetadataRegistry,
  io: 'input' | 'output',
  {
    target,
    libraryOptions,
  }: Parameters<
    CommonSchema.WithJSONSchema['~standard']['jsonSchema'][typeof io]
  >[0],
): Record<string, unknown> {
  const { json = {} } = (libraryOptions ?? {}) as {
    json?: ToJSONSchemaParams
  }
  const { cycles = 'throw', reused = 'inline', ...options } = json
  return toJSONSchema(zodType, {
    ...options,
    target,
    io,
    cycles,
    reused,
    metadata: registry,
  })
}
