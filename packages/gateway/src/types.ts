import type { AnyInjectable, Container, Scope } from '@nmtjs/core'
import type {
  ProtocolClientStreams,
  MessageContext as ProtocolMessageContext,
  ProtocolServerStreams,
} from '@nmtjs/protocol/server'

export type ConnectionIdentity = string
export type ConnectionIdentityResolver = AnyInjectable<
  ConnectionIdentity,
  Scope.Global
>

export type GatewayConnectionRpc = {
  controller: AbortController
  clientStreams: Set<number>
  serverStreams: Set<number>
}

export interface GatewayMessageContext extends ProtocolMessageContext {
  callId: number
  rpc: GatewayConnectionRpc
  serverStreams: ProtocolServerStreams
  clientStreams: ProtocolClientStreams
  container: Container
}
