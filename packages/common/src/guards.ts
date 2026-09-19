export function isAsyncIterable(value: any): value is AsyncIterable<unknown> {
  return value && typeof value === 'object' && Symbol.asyncIterator in value
}

export function isError(value: any): value is Error {
  // Error.isError also recognises errors from other realms; not available everywhere yet
  if ('isError' in Error && typeof Error.isError === 'function') {
    return Error.isError(value)
  }
  return value instanceof Error
}
