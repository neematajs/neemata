import {
  createFactoryInjectable,
  createLazyInjectable,
  Scope,
} from '@nmtjs/core'
import type { Connection } from './connection.ts'

const connection = createLazyInjectable<Connection, Scope.Connection>(
  Scope.Connection,
  'RPC connection',
)

const connectionData = createLazyInjectable<any, Scope.Connection>(
  Scope.Connection,
  "RPC connection's data",
)

const connectionAbortSignal = createLazyInjectable<
  AbortSignal,
  Scope.Connection
>(Scope.Connection, 'Connection abort signal')

const rpcClientAbortSignal = createLazyInjectable<AbortSignal, Scope.Call>(
  Scope.Call,
  'RPC client abort signal',
)

const rpcTimeoutSignal = createLazyInjectable<AbortSignal, Scope.Call>(
  Scope.Call,
  'RPC timeout signal',
)

const rpcAbortSignal = createFactoryInjectable(
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

export const ProtocolInjectables = {
  connection,
  connectionData,
  connectionAbortSignal,
  rpcClientAbortSignal,
  rpcTimeoutSignal,
  rpcAbortSignal,
} as const
