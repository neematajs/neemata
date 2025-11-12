import type { MessagePort } from 'node:worker_threads'

import type { Async } from '@nmtjs/common'
import type { Injection } from '@nmtjs/core'
import type { ConnectionType, ProtocolRPC } from '@nmtjs/protocol'

import type { GatewayConnection } from './connection.ts'

export interface TransportConnectionV2 {
  connectionId: string
  type: ConnectionType
}

export interface TransportV2OnConnectOptions<
  Type extends ConnectionType = ConnectionType,
> {
  protocolVersion: 1
  accept: string | null
  contentType: string | null
  type: Type extends ConnectionType.Bidirectional
    ? Type
    : ConnectionType.Unidirectional
}

export interface TransportV2OnDisconnectOptions {
  connectionId: string
}

export interface TransportV2OnMessageOptions {
  connectionId: string
  data: ArrayBuffer
}

export type TransportV2WorkerHooks<
  Type extends ConnectionType = ConnectionType,
> = {
  onConnect: (
    options: TransportV2OnConnectOptions<Type>,
    ...injections: Injection[]
  ) => Promise<{ connectionId: string }>
  onDisconnect: (options: TransportV2OnDisconnectOptions) => Promise<void>
  onMessage: (
    options: TransportV2OnMessageOptions,
    ...injections: Injection[]
  ) => Promise<void>
  onRpc: (
    connection: GatewayConnection,
    rpc: ProtocolRPC,
    signal: AbortSignal,
    ...injections: Injection[]
  ) => Promise<unknown>
}

export interface TransportV2Main {
  start: (port: MessagePort) => Async<void>
  stop: () => Async<void>
}

export interface TransportV2WorkerOptions<
  Type extends ConnectionType = ConnectionType,
  Options = unknown,
> extends TransportV2WorkerHooks<Type> {
  options: Options
  port?: MessagePort
}

export interface TransportV2Worker<
  Type extends ConnectionType = ConnectionType,
  Options = unknown,
> {
  start: (options: TransportV2WorkerOptions<Type, Options>) => Async<string>
  stop: (options: TransportV2WorkerOptions<Type, Options>) => Async<void>
  send?: Type extends 'unidirectional'
    ? never
    : (connectionId: string, buffer: ArrayBuffer) => boolean | null
}

export interface TransportV2<
  Type extends ConnectionType = ConnectionType,
  Options = unknown,
> {
  worker: TransportV2Worker<Type, Options>
  main?: TransportV2Main
}

// export function createTransportV2Worker(): TransportV2Worker<
//   'bidirectional',
//   { hah: '' }
// > {
//   return {
//     async start({ onConnect, onDisconnect, onMessage, options }) {
//       const { connectionId } = await onConnect(
//         { type: 'bidirectional', accept: null, contentType: null },
//         provide(createLazyInjectable<[1]>(), [1]),
//         provide(createLazyInjectable<[1]>(), [1]),
//         provide(createLazyInjectable<[1]>(), [1]),
//       )

//       const result = await onMessage({ connectionId, data: new ArrayBuffer(8) })

//       return ''
//     },
//     stop() {},
//     send(connectionId: string, buffer: ArrayBuffer) {
//       return true
//     },
//   }
// }
