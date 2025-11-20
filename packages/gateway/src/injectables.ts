import {
  createFactoryInjectable,
  createLazyInjectable,
  Scope,
} from '@nmtjs/core'

import type { GatewayConnection } from './connection.ts'

export const connection = createLazyInjectable<
  GatewayConnection,
  Scope.Connection
>(Scope.Connection, 'Gateway connection')

export const connectionId = createLazyInjectable<
  GatewayConnection['id'],
  Scope.Connection
>(Scope.Connection, 'Gateway connection id')

export const connectionData = createLazyInjectable<unknown, Scope.Connection>(
  Scope.Connection,
  "Gateway connection's data",
)

export const connectionAbortSignal = createLazyInjectable<
  AbortSignal,
  Scope.Connection
>(Scope.Connection, 'Connection abort signal')

export const rpcClientAbortSignal = createLazyInjectable<
  AbortSignal,
  Scope.Call
>(Scope.Call, 'RPC client abort signal')

export const rpcTimeoutSignal = createLazyInjectable<AbortSignal, Scope.Call>(
  Scope.Call,
  'RPC timeout signal',
)

export const rpcAbortSignal = createFactoryInjectable(
  {
    dependencies: {
      rpcTimeoutSignal,
      rpcClientAbortSignal,
      connectionAbortSignal,
    },
    factory: (ctx) => AbortSignal.any(Object.values(ctx)),
  },
  'Any RPC abort signal',
)
