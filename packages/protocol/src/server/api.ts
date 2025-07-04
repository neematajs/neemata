import type { Container, Hook, MetadataStore } from '@nmtjs/core'
import type { Connection } from './connection.ts'
import { kIterableResponse } from './constants.ts'

export type ProtocolApiCallOptions = {
  connection: Connection
  namespace: string
  procedure: string
  container: Container
  payload: any
  signal: AbortSignal
  metadata?: (metadata: MetadataStore) => void
}

export type ProtocolAnyIterable<T> =
  | ((signal: AbortSignal) => AsyncGenerator<T>)
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
  value: any,
): value is ProtocolApiCallIterableResult {
  return value && value[kIterableResponse] === true
}

export function createStreamResponse<Y, O>(
  iterable: ProtocolAnyIterable<Y>,
  {
    onFinish,
    output = undefined as O,
  }: {
    output?: O
    onFinish?: () => void
  },
): ProtocolApiCallIterableResult<Y, O> {
  return {
    [kIterableResponse]: true as const,
    iterable,
    output,
    onFinish,
  }
}

declare module '@nmtjs/core' {
  export interface HookType {
    [Hook.OnConnect]: (connection: Connection) => any
    [Hook.OnDisconnect]: (connection: Connection) => any
  }
}
