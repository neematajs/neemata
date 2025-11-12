import type { Async } from '@nmtjs/common'
import type { Container, MetadataStore } from '@nmtjs/core'

import type { Connection } from './connection.ts'
import { kIterableResponse } from './constants.ts'

export type ProtocolApiCallOptions = {
  connection: Connection
  procedure: string
  container: Container
  payload: any
  signal: AbortSignal
  validateMetadata?: (metadata: MetadataStore) => void
}

export type ProtocolAnyIterable<T> =
  | ((signal: AbortSignal) => Async<AsyncIterable<T>>)
  | AsyncIterable<T>

export interface ProtocolApiCallBaseResult<T = unknown> {
  output: T
}

export interface ProtocolApiCallIterableResult<Y = unknown, O = unknown>
  extends ProtocolApiCallBaseResult<O> {
  [kIterableResponse]: true
  iterable: ProtocolAnyIterable<Y>
  onFinish?: () => void
}

export type ProtocolApiCallResult =
  | ProtocolApiCallBaseResult
  | ProtocolApiCallIterableResult

export interface ProtocolApi {
  call(options: ProtocolApiCallOptions): Promise<ProtocolApiCallResult>
}

export function isIterableResult(
  value: ProtocolApiCallResult,
): value is ProtocolApiCallIterableResult {
  return value && value[kIterableResponse] === true
}

export function createStreamResponse<Y, O>(
  iterable: ProtocolAnyIterable<Y>,
  output = undefined as O,
  onFinish?: () => void,
): ProtocolApiCallIterableResult<Y, O> {
  return { [kIterableResponse]: true as const, iterable, output, onFinish }
}
