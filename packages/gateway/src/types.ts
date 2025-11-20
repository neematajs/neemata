import type { AnyInjectable, Scope } from '@nmtjs/core'

export type ConnectionIdentity = string
export type ConnectionIdentityResolver = AnyInjectable<
  ConnectionIdentity,
  Scope.Global
>
