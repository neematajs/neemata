import { createLazyInjectable, type LazyInjectable, Scope } from '@nmtjs/core'
import { ProtocolInjectables } from '@nmtjs/protocol/server'

const connectionData = ProtocolInjectables.connectionData as LazyInjectable<
  Request,
  Scope.Connection
>

const httpResponseHeaders = createLazyInjectable<Headers, Scope.Call>(
  Scope.Call,
)

export const WsTransportInjectables = {
  connectionData,
  httpResponseHeaders,
} as const
