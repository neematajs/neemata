import type { Container, Logger, Plugin } from '@nmtjs/core'
import { createPlugin } from '@nmtjs/core'

import type { ServerMessageType } from '../common/enums.ts'
import type { Connection } from './connection.ts'
import type { Protocol } from './protocol.ts'
import type { ProtocolRegistry } from './registry.ts'
import type { ProtocolSendMetadata } from './types.ts'
import { kTransportPlugin } from './constants.ts'

export interface Transport<T = unknown> {
  start: () => Promise<void>
  stop: () => Promise<void>
  send: (
    connection: Connection<T>,
    messageType: ServerMessageType,
    buffer: ArrayBuffer,
    metadata: ProtocolSendMetadata,
  ) => any
}

export interface TransportPluginContext {
  container: Container
  protocol: Protocol
  registry: ProtocolRegistry
  logger: Logger
}

export type AnyTransportPlugin = TransportPlugin<any, any>
export interface TransportPlugin<Type = unknown, Options = unknown>
  extends Plugin<Transport<Type>, Options, TransportPluginContext> {
  [kTransportPlugin]: any
}

export const createTransport = <Type = unknown, Options = unknown>(
  name: string,
  factory: TransportPlugin<Type, Options>['factory'],
): TransportPlugin<Type, Options> => {
  const plugin = createPlugin<Transport<Type>, Options, TransportPluginContext>(
    name,
    factory,
  )
  return Object.assign(plugin, { [kTransportPlugin]: true })
}

export const isTransportPlugin = (
  plugin: Plugin<any, any, any>,
): plugin is TransportPlugin => kTransportPlugin in plugin
