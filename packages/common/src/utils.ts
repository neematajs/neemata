export type Future<T = any> = PromiseWithResolvers<T>

export function createFuture<T>(): Future<T> {
  return Promise.withResolvers<T>()
}
