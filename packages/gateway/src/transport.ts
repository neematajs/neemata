import type { Async } from '@nmtjs/common'
import type { Injection, LazyInjectable, Scope } from '@nmtjs/core'
import type { ProtocolRPC } from '@nmtjs/protocol'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { createLazyInjectable, provide } from '@nmtjs/core'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'

import type { GatewayApiCallOptions } from './api.ts'
import type { GatewayConnection } from './connection.ts'

export interface TransportConnectionV2 {
  connectionId: string
  type: ConnectionType
}

export interface TransportV2OnConnectOptions<
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

export interface TransportV2OnDisconnectOptions {
  connectionId: string
}

export interface TransportV2OnMessageOptions {
  connectionId: string
  data: ArrayBuffer
}

export type TransportV2WorkerParams<
  Type extends ConnectionType = ConnectionType,
> = {
  formats: ProtocolFormats
  onConnect: (
    options: TransportV2OnConnectOptions<Type>,
    ...injections: Injection[]
  ) => Promise<GatewayConnection & AsyncDisposable>
  onDisconnect: (options: TransportV2OnDisconnectOptions) => Promise<void>
  onMessage: (
    options: TransportV2OnMessageOptions,
    ...injections: Injection[]
  ) => Promise<void>
  onRpc: (
    connection: GatewayConnection,
    rpc: ProtocolRPC & { metadata?: GatewayApiCallOptions['metadata'] },
    signal: AbortSignal,
    ...injections: Injection[]
  ) => Promise<unknown>
}

export interface TransportV2WorkerStartOptions<
  Type extends ConnectionType = ConnectionType,
> extends TransportV2WorkerParams<Type> {
  // for extra props in the future
}

export interface TransportV2Worker<
  Type extends ConnectionType = ConnectionType,
> {
  start: (params: TransportV2WorkerParams<Type>) => Async<string>
  stop: (params: Pick<TransportV2WorkerParams<Type>, 'formats'>) => Async<void>
  send?: Type extends 'unidirectional'
    ? never
    : (connectionId: string, buffer: ArrayBuffer) => boolean | null
}

export interface TransportV2<
  Type extends ConnectionType = ConnectionType,
  TransportOptions = any,
  Injections extends {
    [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call>
  } = { [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call> },
  Proxyable extends boolean = boolean,
> {
  proxyable: Proxyable
  injectables?: Injections
  factory: (options: TransportOptions) => TransportV2Worker<Type>
}

export function createTransportV2Worker(): TransportV2<
  ConnectionType.Bidirectional,
  { hah: '' },
  {},
  true
> {
  return {
    proxyable: true,
    injectables: {},
    factory: (options) => {
      return {
        async start({ onConnect, onDisconnect, onMessage }) {
          const { id } = await onConnect(
            {
              data: null,
              type: ConnectionType.Bidirectional,
              accept: null,
              contentType: null,
              protocolVersion: ProtocolVersion.v1,
            },
            provide(createLazyInjectable<[1]>(), [1]),
            provide(createLazyInjectable<[1]>(), [1]),
            provide(createLazyInjectable<[1]>(), [1]),
          )

          await onMessage({ connectionId: id, data: new ArrayBuffer(8) })

          return ''
        },
        stop() {},
        send(connectionId: string, buffer: ArrayBuffer) {
          return true
        },
      }
    },
  }
}
