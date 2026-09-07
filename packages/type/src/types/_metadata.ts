import type { ZodMiniType } from 'zod/mini'
import { registry } from 'zod/mini'

export type TypeMetadata<T = any> = {
  id?: string
  description?: string
  examples?: T[]
  title?: string
}

export const typesRegistry = registry<TypeMetadata>()

export type MetadataRegistry = typeof typesRegistry

/** Value schemas own wire metadata independently of transformation validators. */
export type WireZodTypes = { input: ZodMiniType; output: ZodMiniType }

export function mapWireZodTypes(
  create: (side: keyof WireZodTypes) => ZodMiniType,
): WireZodTypes {
  return { input: create('input'), output: create('output') }
}
