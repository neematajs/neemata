import type { Container, MetadataStore } from '@nmtjs/core'

import type { GatewayConnection } from './connection.ts'

export type GatewayApiCallOptions = {
  connection: GatewayConnection
  procedure: string
  container: Container
  payload: any
  signal: AbortSignal
  metadata?: (store: MetadataStore) => void
}

export type GatewayApiCallResult = unknown

export interface GatewayApi {
  call(options: GatewayApiCallOptions): Promise<GatewayApiCallResult>
}

export function isAsyncIterable(
  value: GatewayApiCallResult,
): value is AsyncIterable<unknown> | Iterable<unknown> {
  return Boolean(
    value && typeof value === 'object' && Symbol.asyncIterator in value,
  )
}
