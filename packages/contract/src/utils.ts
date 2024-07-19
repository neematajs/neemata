import type { SchemaOptions, TSchema } from '@sinclair/typebox'

export type ContractSchemaOptions = Pick<SchemaOptions, 'title' | 'description'>

export const applyNames = <T extends Record<string, { serviceName?: string }>>(
  params: T,
  opts: { serviceName?: string; subscriptionName?: string },
) => {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, { ...v, name: k, ...opts }]),
  )
}

export const createSchema = <T extends TSchema>(
  schema: Omit<T, 'static' | 'params'>,
) => schema as T
