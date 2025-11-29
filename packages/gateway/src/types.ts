import type { AnyInjectable, Container, Scope } from '@nmtjs/core'
import type { MessageContext as ProtocolMessageContext } from '@nmtjs/protocol/server'

import type { GatewayApiCallOptions } from './api.ts'

export type ConnectionIdentity = string
export type ConnectionIdentityResolver = AnyInjectable<
  ConnectionIdentity,
  Scope.Global
>

export interface GatewayRpc {
  callId: number
  procedure: string
  payload: unknown
  metadata?: GatewayApiCallOptions['metadata']
}

export interface GatewayRpcContext extends ProtocolMessageContext, GatewayRpc {
  container: Container
  signal: AbortSignal
  [Symbol.asyncDispose](): Promise<void>
}
