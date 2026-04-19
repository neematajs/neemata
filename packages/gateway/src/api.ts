import type {
  AnyMeta,
  Container,
  ResolveInjectableType,
  StaticMetaBinding,
} from '@nmtjs/core'
import { getMetaBindingMeta } from '@nmtjs/core'

import type { GatewayConnection } from './connections.ts'

export interface GatewayStaticMetaView {
  get<T extends AnyMeta>(meta: T): ResolveInjectableType<T> | undefined
  has<T extends AnyMeta>(meta: T): boolean
  entries(): readonly StaticMetaBinding[]
}

export interface GatewayResolvedProcedure {
  stream: boolean
  meta: GatewayStaticMetaView
}

export type GatewayResolveOptions = {
  connection: GatewayConnection
  procedure: string
}

export type GatewayApiCallOptions = {
  connection: GatewayConnection
  procedure: string
  container: Container
  payload: any
  signal: AbortSignal
}

export type GatewayApiCallResult = unknown

export interface GatewayApi {
  resolve(options: GatewayResolveOptions): Promise<GatewayResolvedProcedure>
  call(options: GatewayApiCallOptions): Promise<GatewayApiCallResult>
}

export function createGatewayStaticMetaView(
  bindings: readonly StaticMetaBinding[],
): GatewayStaticMetaView {
  return Object.freeze({
    get<T extends AnyMeta>(meta: T) {
      let value: ResolveInjectableType<T> | undefined

      for (const binding of bindings) {
        if (getMetaBindingMeta(binding) === meta) {
          value = binding.value as ResolveInjectableType<T>
        }
      }

      return value
    },
    has<T extends AnyMeta>(meta: T) {
      return bindings.some((binding) => getMetaBindingMeta(binding) === meta)
    },
    entries() {
      return bindings
    },
  })
}

export function isAsyncIterable(
  value: GatewayApiCallResult,
): value is AsyncIterable<unknown> | Iterable<unknown> {
  return Boolean(
    value && typeof value === 'object' && Symbol.asyncIterator in value,
  )
}
