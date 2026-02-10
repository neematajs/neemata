import { registry } from 'zod/mini'

export type TypeMetadata<T = any> = {
  id?: string
  description?: string
  examples?: T[]
  title?: string
}

export const typesRegistry = registry<TypeMetadata>()

export type MetadataRegistry = typeof typesRegistry
