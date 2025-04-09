import type { LazyInjectable, Scope } from '@nmtjs/core'
import { ProtocolInjectables } from '@nmtjs/protocol/server'
import type { WsUserData } from './types.ts'

const connectionData = ProtocolInjectables.connectionData as LazyInjectable<
  WsUserData['request'],
  Scope.Connection
>

export const WsTransportInjectables = {
  connectionData,
} as const
