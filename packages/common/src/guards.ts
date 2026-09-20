export function isGeneratorFunction(value: any): value is GeneratorFunction {
  return (
    typeof value === 'function' &&
    value.constructor.name === 'GeneratorFunction'
  )
}

export function isAsyncGeneratorFunction(
  value: any,
): value is AsyncGeneratorFunction {
  return (
    typeof value === 'function' &&
    value.constructor.name === 'AsyncGeneratorFunction'
  )
}

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
