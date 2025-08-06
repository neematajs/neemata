import { createLazyInjectable, type LazyInjectable, Scope } from '@nmtjs/core'
import { ProtocolInjectables } from '@nmtjs/protocol/server'
import type { WsTransportServerRequest } from './types.ts'

const connectionData = ProtocolInjectables.connectionData as LazyInjectable<
  WsTransportServerRequest,
  Scope.Connection
>

const httpResponseHeaders = createLazyInjectable<Headers, Scope.Call>(
  Scope.Call,
)

export const WsTransportInjectables = {
  connectionData,
  httpResponseHeaders,
} as const
