import type { ServerStoreConfig } from '../server/config.ts'
import type { StoreTypes } from '../types.ts'
import { StoreType } from '../enums.ts'

export async function createStoreClient<T extends ServerStoreConfig>(
  config: T,
): Promise<StoreTypes[T['type']]> {
  if (config.type === StoreType.Redis) {
    const { Redis } = await import('ioredis').catch(() => {
      throw new Error(
        'ioredis package is not installed. Please install it to use Redis store.',
      )
    })
    return new Redis({
      ...config.options,
      lazyConnect: true,
    }) as StoreTypes[T['type']]
  } else if (config.type === StoreType.Valkey) {
    const { Redis } = await import('iovalkey').catch(() => {
      throw new Error(
        'iovalkey package is not installed. Please install it to use Valkey store.',
      )
    })
    return new Redis({
      ...config.options,
      lazyConnect: true,
    }) as StoreTypes[T['type']]
  }
  throw new Error('Unsupported store')
}
