import type { SchemaOptions, TSchema } from '@sinclair/typebox'

export type NeemataContractSchemaOptions = Pick<
  SchemaOptions,
  'title' | 'description'
>

export const createSchema = <T extends TSchema>(
  schema: Omit<T, 'static' | 'params'>,
) => schema as T
