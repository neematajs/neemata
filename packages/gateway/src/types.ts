import type { AnyInjectable, Container, Logger, Scope } from '@nmtjs/core'
import type { MessageContext as ProtocolMessageContext } from '@nmtjs/protocol/server'

import type { GatewayApiCallOptions } from './api.ts'

export type ConnectionIdentityType = string
export type ConnectionIdentity = AnyInjectable<
  ConnectionIdentityType,
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
  logger: Logger
  [Symbol.asyncDispose](): Promise<void>
}
