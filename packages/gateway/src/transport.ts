import type { Async } from '@nmtjs/common'
import type { Injection, LazyInjectable, Scope } from '@nmtjs/core'
import type {
  ConnectionType,
  ProtocolRPCPayload,
  ProtocolVersion,
} from '@nmtjs/protocol'
import type { ProtocolFormats } from '@nmtjs/protocol/server'

import type { GatewayApiCallOptions } from './api.ts'
import type { GatewayConnection } from './connection.ts'
import type { ProxyableTransportType } from './enums.ts'

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

export interface TransportOnDisconnectOptions {
  connectionId: string
}

export interface TransportOnMessageOptions {
  connectionId: string
  data: ArrayBuffer
}

export type TransportWorkerParams<
  Type extends ConnectionType = ConnectionType,
> = {
  formats: ProtocolFormats
  onConnect: (
    options: TransportOnConnectOptions<Type>,
    ...injections: Injection[]
  ) => Promise<GatewayConnection & AsyncDisposable>
  onDisconnect: (options: TransportOnDisconnectOptions) => Promise<void>
  onMessage: (
    options: TransportOnMessageOptions,
    ...injections: Injection[]
  ) => Promise<void>
  onRpc: (
    connection: GatewayConnection,
    rpc: ProtocolRPCPayload & { metadata?: GatewayApiCallOptions['metadata'] },
    signal: AbortSignal,
    ...injections: Injection[]
  ) => Promise<unknown>
}

export interface TransportWorkerStartOptions<
  Type extends ConnectionType = ConnectionType,
> extends TransportWorkerParams<Type> {
  // for extra props in the future
}

export interface TransportWorker<Type extends ConnectionType = ConnectionType> {
  start: (params: TransportWorkerParams<Type>) => Async<string>
  stop: (params: Pick<TransportWorkerParams<Type>, 'formats'>) => Async<void>
  send?: Type extends 'unidirectional'
    ? never
    : (connectionId: string, buffer: ArrayBufferView) => boolean | null
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
> {
  proxyable: Proxyable
  injectables?: Injections
  factory: (options: TransportOptions) => Async<TransportWorker<Type>>
}
