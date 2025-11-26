import assert from 'node:assert'
import { randomUUID } from 'node:crypto'

import type { Container, Hooks, Injection, Logger } from '@nmtjs/core'
import type { ProtocolRPC } from '@nmtjs/protocol'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { isAbortError } from '@nmtjs/common'
import { provide, Scope } from '@nmtjs/core'
import { ClientMessageType, ServerMessageType } from '@nmtjs/protocol'
import {
  ProtocolClientStreams,
  ProtocolServerStreams,
  versions,
} from '@nmtjs/protocol/server'

import type { GatewayApi } from './api.ts'
import type { GatewayConnection } from './connection.ts'
import type { ProxyableTransportType } from './enums.ts'
import type { TransportWorker, TransportWorkerParams } from './transport.ts'
import type { ConnectionIdentityResolver } from './types.ts'
import type { MessageContext } from './utils.ts'
import { isAsyncIterable } from './api.ts'
import { GatewayConnections } from './connections.ts'
import * as injectables from './injectables.ts'

export interface GatewayOptions {
  logger: Logger
  container: Container
  hooks: Hooks
  formats: ProtocolFormats
  api: GatewayApi
  identityResolver: ConnectionIdentityResolver
  transports: {
    [key: string]: {
      transport: TransportWorker
      proxyable?: ProxyableTransportType
    }
  }
}

export class Gateway {
  connections: GatewayConnections

  constructor(protected options: GatewayOptions) {
    this.connections = new GatewayConnections({
      logger: this.options.logger,
      container: this.options.container,
      hooks: this.options.hooks,
      formats: this.options.formats,
    })
  }

  async start() {
    const hosts: { url: string; type: ProxyableTransportType }[] = []
    for (const key in this.options.transports) {
      const { transport, proxyable } = this.options.transports[key]
      const url = await transport.start({
        formats: this.options.formats,
        onConnect: this.onConnect(key),
        onDisconnect: this.onDisconnect(key),
        onMessage: this.onMessage(key),
        onRpc: this.onRpc(key),
      })
      this.options.logger.info(`Transport [${key}] started on [${url}]`)
      if (proxyable) hosts.push({ url, type: proxyable })
    }
    return hosts
  }

  async stop() {
    await this.connections.closeAll()
    for (const key in this.options.transports) {
      const { transport } = this.options.transports[key]
      await transport.stop({ formats: this.options.formats })
      this.options.logger.info(`Transport [${key}] stopped`)
    }
  }

  send(transport: string, connectionId: string, data: ArrayBufferView) {
    if (transport in this.options.transports) {
      const send = this.options.transports[transport].transport.send
      if (send) return send(connectionId, data)
    }
  }

  protected createMessageContext(
    connection: GatewayConnection,
    transport: string,
  ): MessageContext {
    return {
      clientStreams: new ProtocolClientStreams(connection.clientStreams),
      serverStreams: new ProtocolServerStreams(connection.serverStreams),
      connectionId: connection.id,
      decoder: connection.decoder,
      encoder: connection.encoder,
      rpcs: connection.rpcs,
      protocol: connection.protocol,
      transport: this.options.transports[transport].transport,
      container: connection.container,
      streamId: connection.getStreamId,
    }
  }

  protected onConnect(transport: string): TransportWorkerParams['onConnect'] {
    return async (options, ...injections) => {
      const protocol = versions[options.protocolVersion]
      if (!protocol) throw new Error('Unsupported protocol version')
      const id = randomUUID()
      const container = this.options.container.fork(Scope.Connection)
      try {
        await container.provide([
          provide(injectables.connectionData, options.data),
          provide(injectables.connectionId, id),
        ])
        await container.provide(injections)

        const identity = await container.resolve(this.options.identityResolver)
        const connection = await this.connections.open({
          id,
          container,
          identity,
          transport,
          protocol,
          options,
        })

        await container.provide(injectables.connection, connection)

        return Object.assign(connection, {
          [Symbol.asyncDispose]: async () => {
            await this.onDisconnect(transport)({ connectionId: connection.id })
          },
        })
      } catch (error) {
        container.dispose()
        throw error
      }
    }
  }

  protected onDisconnect(
    transport: string,
  ): TransportWorkerParams['onDisconnect'] {
    return async ({ connectionId }) => {
      await this.connections.close(connectionId)
    }
  }

  protected onMessage(transport: string): TransportWorkerParams['onMessage'] {
    return async ({ connectionId, data }, ...injections) => {
      const connection = this.connections.get(connectionId)
      assert(connection, 'Connection not found')
      const context = this.createMessageContext(connection, transport)
      const message = context.protocol.decodeMessage(context, Buffer.from(data))
      // console.dir(message)
      switch (message.type) {
        case ClientMessageType.Rpc: {
          await this.handleRpc(connection, context, message.rpc, injections)
          break
        }
        case ClientMessageType.RpcAbort: {
          const controller = connection.rpcs.get(message.callId)
          if (controller) controller.abort()
          break
        }
        case ClientMessageType.ClientStreamAbort: {
          context.clientStreams.abort(message.streamId, message.reason)
          break
        }
        case ClientMessageType.ClientStreamPush: {
          context.clientStreams.push(message.streamId, message.chunk)
          break
        }
        case ClientMessageType.ClientStreamEnd: {
          context.clientStreams.end(message.streamId)
          break
        }
        case ClientMessageType.ServerStreamAbort: {
          context.serverStreams.abort(message.streamId, message.reason)
          break
        }
        case ClientMessageType.ServerStreamPull: {
          context.serverStreams.pull(message.streamId)
          break
        }
        default: {
          throw new Error('Unknown message type')
        }
      }
    }
  }

  protected onRpc(transport: string): TransportWorkerParams['onRpc'] {
    return async (connection, rpc, signal, ...injections) => {
      const context = this.createMessageContext(
        connection,
        connection.transport,
      )
      await using container = context.container.fork(Scope.Call)
      const controller = new AbortController()
      signal.addEventListener('abort', controller.abort, { once: true })
      connection.rpcs.set(rpc.callId, controller)
      await container.provide(injections)
      return await this.options.api.call({
        connection,
        container,
        payload: rpc.payload,
        procedure: rpc.procedure,
        metadata: rpc.metadata,
        signal: controller.signal,
      })
    }
  }

  protected async handleRpc(
    connection: GatewayConnection,
    context: MessageContext,
    rpc: ProtocolRPC,
    injections: Injection[],
    signal?: AbortSignal,
  ): Promise<void> {
    const {
      container: connectionContainer,
      connectionId,
      rpcs,
      encoder,
      transport,
      protocol,
    } = context
    const { callId, procedure, payload } = rpc
    const controller = new AbortController()
    rpcs.set(rpc.callId, controller)
    signal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal

    await using container = connectionContainer.fork(Scope.Call)
    try {
      await container.provide(injections)

      const response = await this.options.api.call({
        connection,
        container,
        payload,
        procedure,
        signal,
      })

      if (isAsyncIterable(response)) {
        transport.send?.(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.RpcStreamResponse, {
            callId,
          }),
        )

        try {
          try {
            for await (const chunk of response) {
              if (signal.aborted) break
              const chunkEncoded = encoder.encode(chunk)
              transport.send?.(
                connectionId,
                protocol.encodeMessage(
                  context,
                  ServerMessageType.RpcStreamChunk,
                  { callId, chunk: chunkEncoded },
                ),
              )
            }
            transport.send?.(
              connectionId,
              protocol.encodeMessage(context, ServerMessageType.RpcStreamEnd, {
                callId,
              }),
            )
          } catch (error) {
            // do not re-throw AbortError errors, they are expected
            if (!isAbortError(error)) {
              throw error
            }
          }
        } catch (error) {
          this.options.logger.error(error)
          transport.send?.(
            connectionId,
            protocol.encodeMessage(context, ServerMessageType.RpcStreamAbort, {
              callId,
            }),
          )
        }
      } else {
        transport.send?.(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.RpcResponse, {
            callId,
            result: response,
            error: null,
          }),
        )
      }
    } catch (error) {
      transport.send?.(
        connectionId,
        protocol.encodeMessage(context, ServerMessageType.RpcResponse, {
          callId,
          result: null,
          error,
        }),
      )
    } finally {
      rpcs.delete(callId)
    }
  }
}
