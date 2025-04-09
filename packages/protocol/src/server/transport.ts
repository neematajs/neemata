import type { BasePlugin, PluginContext } from '@nmtjs/core'
import type { Async } from '../../../common/src/index.ts'
import type { ServerMessageType } from '../common/enums.ts'
import type { Connection } from './connection.ts'
import { kTransportPlugin } from './constants.ts'
import type { Protocol } from './protocol.ts'
import type { ProtocolRegistry } from './registry.ts'

export interface Transport<T = unknown> {
  start: () => Promise<void>
  stop: () => Promise<void>
  send: (
    connection: Connection<T>,
    messageType: ServerMessageType,
    buffer: ArrayBuffer,
  ) => Async<void>
}

export interface TransportPluginContext extends PluginContext {
  protocol: Protocol
  registry: ProtocolRegistry
}

export interface TransportPlugin<Type = unknown, Options = unknown>
  extends BasePlugin<Transport<Type>, Options, TransportPluginContext> {
  [kTransportPlugin]: any
}

export const createTransport = <Type = unknown, Options = unknown>(
  name: string,
  init: TransportPlugin<Type, Options>['init'],
): TransportPlugin<Type, Options> => ({ name, init, [kTransportPlugin]: true })

export const isTransportPlugin = (
  plugin: BasePlugin<any, any, any>,
): plugin is TransportPlugin => kTransportPlugin in plugin
