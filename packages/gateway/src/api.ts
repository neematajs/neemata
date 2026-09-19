import type {
  AnyMeta,
  Container,
  ResolveInjectableType,
  StaticMetaBinding,
} from '@nmtjs/core'
import { getMetaBindingMeta, getStaticMetaValue } from '@nmtjs/core'

import type { GatewayConnection } from './connections.ts'

export interface GatewayStaticMetaView {
  get<T extends AnyMeta>(meta: T): ResolveInjectableType<T> | undefined
  has<T extends AnyMeta>(meta: T): boolean
  entries(): readonly StaticMetaBinding[]
}

export interface GatewayResolvedProcedure {
  name: string
  stream: boolean
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

export interface GatewayApi<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  resolve(options: GatewayResolveOptions): Promise<ResolvedProcedure>
  call(options: GatewayApiCallOptions): Promise<GatewayApiCallResult>
}

export function createGatewayStaticMetaView(
  bindings: readonly StaticMetaBinding[],
): GatewayStaticMetaView {
  return Object.freeze({
    get<T extends AnyMeta>(meta: T) {
      return getStaticMetaValue(bindings, meta)
    },
    has<T extends AnyMeta>(meta: T) {
      return bindings.some((binding) => getMetaBindingMeta(binding) === meta)
    },
    entries() {
      return bindings
    },
  })
}
