import type { MaybePromise } from '@nmtjs/common'
import type { LazyInjectable, Provision, Scope } from '@nmtjs/core'
import type { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import type { ProtocolFormats } from '@nmtjs/protocol/server'

import type { GatewayResolvedProcedure } from './api.ts'
import type { GatewayConnection } from './connections.ts'
import type { ProxyableTransportType } from './enums.ts'
import type { GatewayRpc } from './types.ts'

export interface TransportConnection {
  connectionId: string
  type: ConnectionType
}

export interface TransportOnConnectOptions<
  Type extends ConnectionType = ConnectionType,
> {
  type: Type extends ConnectionType.Bidirectional
    ? Type
    : ConnectionType.Unidirectional
  protocolVersion: ProtocolVersion
  accept: string | null
  contentType: string | null
  data: unknown
}

export interface TransportOnMessageOptions {
  connectionId: string
  data: ArrayBuffer
}

export type TransportWorkerParams<
  Type extends ConnectionType = ConnectionType,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> = {
  formats: ProtocolFormats
  onConnect: (
    options: TransportOnConnectOptions<Type>,
    ...injections: Provision[]
  ) => Promise<GatewayConnection & AsyncDisposable>
  onDisconnect: (connectionId: GatewayConnection['id']) => Promise<void>
  onMessage: (
    options: TransportOnMessageOptions,
    ...injections: Provision[]
  ) => Promise<void>
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

export interface TransportWorkerStartOptions<
  Type extends ConnectionType = ConnectionType,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> extends TransportWorkerParams<Type, ResolvedProcedure> {
  // for extra props in the future
}

export interface TransportWorker<
  Type extends ConnectionType = ConnectionType,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  start: (
    params: TransportWorkerParams<Type, ResolvedProcedure>,
  ) => MaybePromise<string>
  stop: (
    params: Pick<TransportWorkerParams<Type, ResolvedProcedure>, 'formats'>,
  ) => MaybePromise<void>
  send?: Type extends 'unidirectional'
    ? never
    : (connectionId: string, buffer: ArrayBufferView) => boolean | null
  close?: Type extends 'unidirectional'
    ? never
    : (
        connectionId: string,
        options?: { code?: number; reason?: string },
      ) => MaybePromise<void>
}

export interface Transport<
  Type extends ConnectionType = ConnectionType,
  TransportOptions = any,
  Injections extends {
    [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call>
  } = { [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call> },
  Proxyable extends ProxyableTransportType | undefined =
    | ProxyableTransportType
    | undefined,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  proxyable: Proxyable
  injectables?: Injections
  factory: (
    options: TransportOptions,
  ) => MaybePromise<TransportWorker<Type, ResolvedProcedure>>
}

export function createTransport<
  Type extends ConnectionType = ConnectionType,
  TransportOptions = any,
  Injections extends {
    [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call>
  } = { [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call> },
  Proxyable extends ProxyableTransportType | undefined =
    | ProxyableTransportType
    | undefined,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
>(
  config: Transport<
    Type,
    TransportOptions,
    Injections,
    Proxyable,
    ResolvedProcedure
  >,
): Transport<Type, TransportOptions, Injections, Proxyable, ResolvedProcedure> {
  return config
}
