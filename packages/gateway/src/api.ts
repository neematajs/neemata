import type { Container } from '@nmtjs/core'

export type ProtocolApiCallOptions = {
  procedure: string
  container: Container
  payload: any
  signal: AbortSignal
}

export type ProtocolApiCallResult = unknown

export interface ProtocolApi {
  call(options: ProtocolApiCallOptions): Promise<ProtocolApiCallResult>
}

export function isIterable(
  value: ProtocolApiCallResult,
): value is AsyncIterable<unknown> | Iterable<unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (Symbol.asyncIterator in value || Symbol.iterator in value),
  )
}
