import type { MaybePromise } from '@nmtjs/common'
import type { LazyInjectable, Provision, Scope } from '@nmtjs/core'

import type { GatewayResolvedProcedure } from './api.ts'
import type { GatewayConnection } from './connections.ts'
import type { ProxyableTransportType } from './enums.ts'
import type { GatewayRpc } from './types.ts'

export type TransportOnConnectOptions = {
  /**
   * Transport-defined connection payload exposed to the application through
   * the connection-data injectable (e.g. the upgrade/fetch Request).
   */
  data: unknown
}

/**
 * The handler-facing gateway surface: open an application connection,
 * resolve a procedure, invoke it with runtime values, close the connection.
 * No wire-level concept (codecs, frames, call ids, credits) crosses it —
 * those belong to the transport handler that owns the physical connection.
 */
export type TransportWorkerParams<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> = {
  onConnect: (
    options: TransportOnConnectOptions,
    ...injections: Provision[]
  ) => Promise<GatewayConnection & AsyncDisposable>
  onDisconnect: (connectionId: GatewayConnection['id']) => Promise<void>
  resolve: (
    connection: GatewayConnection,
    procedure: GatewayRpc['procedure'],
  ) => Promise<ResolvedProcedure>
  onRpc: (
    connection: GatewayConnection,
    rpc: GatewayRpc,
    signal: AbortSignal,
    ...injections: Provision[]
  ) => Promise<unknown>
}

export interface TransportWorker<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  start: (
    params: TransportWorkerParams<ResolvedProcedure>,
  ) => MaybePromise<string>
  stop: () => MaybePromise<void>
}

export type TransportInjections = {
  [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call>
}

export type TransportProxyable = readonly ProxyableTransportType[] | undefined

export interface Transport<
  TransportOptions = any,
  Injections extends TransportInjections = TransportInjections,
  Proxyable extends TransportProxyable = TransportProxyable,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  proxyable: Proxyable
  injectables?: Injections
  factory: (
    options: TransportOptions,
  ) => MaybePromise<TransportWorker<ResolvedProcedure>>
}

export function createTransport<
  TransportOptions = any,
  Injections extends TransportInjections = TransportInjections,
  Proxyable extends TransportProxyable = TransportProxyable,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
>(
  config: Transport<TransportOptions, Injections, Proxyable, ResolvedProcedure>,
): Transport<TransportOptions, Injections, Proxyable, ResolvedProcedure> {
  return config
}
