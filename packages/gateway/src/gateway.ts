import assert from 'node:assert'
import { randomUUID } from 'node:crypto'

import type { Container, Hooks, Injection, Logger } from '@nmtjs/core'
import type { ProtocolRPC } from '@nmtjs/protocol'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { isAbortError, unique } from '@nmtjs/common'
import { Scope } from '@nmtjs/core'
import {
  ClientMessageType,
  ErrorCode,
  ServerMessageType,
} from '@nmtjs/protocol'
import {
  ProtocolClientStreams,
  ProtocolError,
  ProtocolServerStreams,
  versions,
} from '@nmtjs/protocol/server'

import type { GatewayApi, GatewayApiCallOptions } from './api.ts'
import type { GatewayConnection } from './connection.ts'
import type { TransportV2Worker, TransportV2WorkerHooks } from './transport.ts'
import type { ConnectionIdentityResolver } from './types.ts'
import type { MessageContext } from './utils.ts'
import { isIterable } from './api.ts'
import { GatewayConnections } from './connections.ts'
import * as injectables from './injectables.ts'

export interface GatewayOptions {
  logger: Logger
  container: Container
  hooks: Hooks
  formats: ProtocolFormats
  api: GatewayApi
  identityResolver: ConnectionIdentityResolver
  transports: { [key: string]: TransportV2Worker }
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
    const hosts: string[] = []
    for (const key in this.options.transports) {
      const transport = this.options.transports[key]
      const host = await transport.start({
        onConnect: this.onConnect(key),
        onDisconnect: this.onDisconnect(key),
        onMessage: this.onMessage(key),
        onRpc: this.onRpc,
      })
      this.options.logger.info(`Transport [${key}] started on [${host}]`)
      hosts.push(host)
    }
    return unique(hosts)
  }

  async stop() {
    for (const key in this.options.transports) {
      const transport = this.options.transports[key]
      await transport.stop({
        onConnect: this.onConnect(key),
        onDisconnect: this.onDisconnect(key),
        onMessage: this.onMessage(key),
        onRpc: this.onRpc,
      })
      this.options.logger.info(`Transport [${key}] stopped`)
    }
  }

  send(transport: string, connectionId: string, data: ArrayBuffer) {
    if (transport in this.options.transports) {
      const send = this.options.transports[transport].send
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
      transport: this.options.transports[transport],
      container: connection.container,
      streamId: connection.getStreamId,
    }
  }

  protected onConnect(transport: string): TransportV2WorkerHooks['onConnect'] {
    return async (options, ...injections) => {
      const protocol = versions[options.protocolVersion]
      if (!protocol) throw new Error('Unsupported protocol version')
      const id = randomUUID()

      const container = this.options.container.fork(Scope.Connection)
      for (const i of injections) container.provide(i.token, i.value)

      container.provide(injectables.connectionData, options.data)
      container.provide(injectables.connectionId, id)

      const identity = await container.resolve(this.options.identityResolver)
      const { connection, signals } = await this.connections.open({
        id,
        container,
        identity,
        transport,
        protocol,
        options,
      })

      container.provide(injectables.connection, connection)
      container.provide(
        injectables.connectionAbortSignal,
        signals.disconnect.signal,
      )

      return connection
    }
  }

  protected onDisconnect(
    transport: string,
  ): TransportV2WorkerHooks['onDisconnect'] {
    return async ({ connectionId }) => {
      await this.connections.close(connectionId)
    }
  }

  protected onMessage(transport: string): TransportV2WorkerHooks['onMessage'] {
    return async ({ connectionId, data }, ...injections) => {
      const connection = this.connections.get(connectionId)
      assert(connection, 'Connection not found')
      const context = this.createMessageContext(connection, transport)
      const message = context.protocol.decodeMessage(context, Buffer.from(data))

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
        default:
      }
    }
  }

  protected onRpc: TransportV2WorkerHooks['onRpc'] = async (
    connection,
    rpc,
    signal,
    ...injections
  ) => {
    const context = this.createMessageContext(connection, connection.transport)
    const container = context.container.fork(Scope.Call)
    for (const { token, value } of injections) {
      container.provide(token, value)
    }

    try {
      return await this.callApi({
        connection,
        container,
        payload: rpc.payload,
        procedure: rpc.procedure,
        signal,
      })
    } catch (error) {
      container.dispose()
      throw error
    }
  }

  protected async callApi(options: GatewayApiCallOptions) {
    try {
      return await this.options.api.call(options)
    } catch (error) {
      if (error instanceof ProtocolError === false) {
        this.options.logger.error({ error }, 'Error during RPC call')
        throw new ProtocolError(
          ErrorCode.InternalServerError,
          'Internal server error',
        )
      }
      throw error
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

    const container = connectionContainer.fork(Scope.Call)

    for (const { token, value } of injections) {
      container.provide(token, value)
    }

    try {
      const response = await this.callApi({
        connection,
        container,
        payload,
        procedure,
        signal,
      })

      if (isIterable(response)) {
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
      container.dispose()
    }
  }
}
