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

/**
 * Aborts when the underlying connection is closed.
 *
 * Scope: Connection
 *
 * Use this when work should be cancelled as soon as the peer disconnects.
 */
export const connectionAbortSignal = createLazyInjectable<
  AbortSignal,
  Scope.Connection
>(Scope.Connection, 'Connection abort signal')

/**
 * The per-RPC signal controlled by the transport/client side.
 *
 * Scope: Call
 *
 * This is aborted for call-level cancellation (client abort, client timeout,
 * or request abort in unidirectional transports).
 */
export const rpcClientAbortSignal = createLazyInjectable<
  AbortSignal,
  Scope.Call
>(Scope.Call, 'RPC client abort signal')

/**
 * Optional stream-specific timeout/cancellation signal.
 *
 * Scope: Call
 *
 * This is provided only when stream timeout logic is enabled by the runtime
 * for the procedure (i.e. when `procedure.streamTimeout` is configured).
 * Prefer rpcAbortSignal for general handler cancellation.
 */
export const rpcStreamAbortSignal = createLazyInjectable<
  AbortSignal,
  Scope.Call
>(Scope.Call, 'RPC stream abort signal')

/**
 * Unified RPC cancellation signal.
 *
 * Scope: Call
 *
 * Combines rpcClientAbortSignal, connectionAbortSignal, and (if present)
 * rpcStreamAbortSignal. This is the recommended signal for procedure logic.
 */
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
