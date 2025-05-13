import type {
  Container,
  Metadata,
  MetadataKey,
  MetadataStore,
} from '@nmtjs/core'
import type { Hook } from '@nmtjs/core'
import type { Connection } from './connection.ts'

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
  | (() => AsyncGenerator<T>)
  | AsyncIterable<T>

export interface ProtocolApiCallBaseResult {
  output: unknown
}
export interface ProtocolApiCallSubscriptionResult
  extends ProtocolApiCallBaseResult {
  subscription: never
}

export interface ProtocolApiCallIterableResult
  extends ProtocolApiCallBaseResult {
  iterable: ProtocolAnyIterable<unknown>
  onFinish?: () => void
}

export type ProtocolApiCallResult =
  | ProtocolApiCallBaseResult
  | ProtocolApiCallSubscriptionResult
  | ProtocolApiCallIterableResult

export const isIterableResult = (
  result: ProtocolApiCallResult,
): result is ProtocolApiCallIterableResult => 'iterable' in result

export const isSubscriptionResult = (
  result: ProtocolApiCallResult,
): result is ProtocolApiCallSubscriptionResult => 'subscription' in result

export interface ProtocolApi {
  call(options: ProtocolApiCallOptions): Promise<ProtocolApiCallResult>
}

declare module '@nmtjs/core' {
  export interface HookType {
    [Hook.OnConnect]: (connection: Connection) => any
    [Hook.OnDisconnect]: (connection: Connection) => any
  }
}
