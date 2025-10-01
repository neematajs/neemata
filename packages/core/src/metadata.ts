import { kMetadata } from './constants.ts'

export type Metadata<T = any> = { key: MetadataKey<T>; value: T }

export type MetadataKey<T = any> = {
  [kMetadata]: string
  as(value: T): Metadata<T>
}

export const createMetadataKey = <T>(key: string): MetadataKey<T> => {
  const metadataKey = {
    [kMetadata]: key,
    as(value: T) {
      return { key: metadataKey, value }
    },
  }
  return metadataKey
}

export class MetadataStore extends Map<MetadataKey, Metadata> {
  get<T>(key: MetadataKey<T>): T | undefined {
    return super.get(key) as T | undefined
  }
}
