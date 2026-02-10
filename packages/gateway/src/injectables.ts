import type { Readable } from 'node:stream'

import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import { anyAbortSignal } from '@nmtjs/common'
import {
  createFactoryInjectable,
  createLazyInjectable,
  createOptionalInjectable,
  Scope,
} from '@nmtjs/core'

import type { GatewayConnection } from './connections.ts'

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

export const rpcStreamAbortSignal = createLazyInjectable<
  AbortSignal,
  Scope.Call
>(Scope.Call, 'RPC stream abort signal')

export const rpcAbortSignal = createFactoryInjectable(
  {
    dependencies: {
      rpcClientAbortSignal,
      connectionAbortSignal,
      rpcStreamAbortSignal: createOptionalInjectable(rpcStreamAbortSignal),
    },
    factory: (ctx) =>
      anyAbortSignal(
        ctx.rpcClientAbortSignal,
        ctx.connectionAbortSignal,
        ctx.rpcStreamAbortSignal,
      ),
  },
  'Any RPC abort signal',
)

export const createBlob = createLazyInjectable<
  (
    source:
      | Readable
      | globalThis.ReadableStream
      | File
      | Blob
      | string
      | ArrayBuffer
      | Uint8Array,
    metadata?: ProtocolBlobMetadata,
  ) => ProtocolBlobInterface,
  Scope.Call
>(Scope.Call, 'Create RPC blob')

export const GatewayInjectables = {
  connection,
  connectionId,
  connectionData,
  connectionAbortSignal,
  rpcClientAbortSignal,
  rpcStreamAbortSignal,
  rpcAbortSignal,
  createBlob,
}
