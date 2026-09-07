import type { AnyInjectable, Scope } from '@nmtjs/core'

export type ConnectionIdentityType = string
export type ConnectionIdentity = AnyInjectable<
  ConnectionIdentityType,
  Scope.Global
>

export interface GatewayRpc {
  procedure: string
  payload: unknown
}
