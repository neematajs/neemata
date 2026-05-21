import type { AnyInjectable, Container, Logger, Scope } from '@nmtjs/core'
import type { ConnectionType } from '@nmtjs/protocol'
import type { MessageContext as ProtocolMessageContext } from '@nmtjs/protocol/server'

export type ConnectionIdentityType = string
export type ConnectionIdentity = AnyInjectable<
  ConnectionIdentityType,
  Scope.Global
>

export interface GatewayRpc {
  callId: number
  procedure: string
  payload: unknown
}

export interface GatewayRpcContext extends ProtocolMessageContext, GatewayRpc {
  connectionType: ConnectionType
  container: Container
  signal: AbortSignal
  logger: Logger
  [Symbol.asyncDispose](): Promise<void>
}
