import assert from 'node:assert'
import { randomUUID } from 'node:crypto'

import type { Container, Hooks, Logger } from '@nmtjs/core'
import type {
  ProtocolFormats,
  MessageContext as ProtocolMessageContext,
} from '@nmtjs/protocol/server'
import { isAbortError } from '@nmtjs/common'
import { provide, Scope } from '@nmtjs/core'
import { ClientMessageType, ServerMessageType } from '@nmtjs/protocol'
import { ProtocolError, versions } from '@nmtjs/protocol/server'

import type { GatewayApi } from './api.ts'
import type { GatewayConnection } from './connection.ts'
import type { ProxyableTransportType, StreamTimeout } from './enums.ts'
import type { TransportWorker, TransportWorkerParams } from './transport.ts'
import type {
  ConnectionIdentityResolver,
  GatewayRpc,
  GatewayRpcContext,
} from './types.ts'
import { isAsyncIterable } from './api.ts'
import {
  GatewayConnectionClientStreams,
  GatewayConnectionServerStreams,
} from './connection.ts'
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
  streamTimeouts?: {
    [StreamTimeout.Finish]?: number
    [StreamTimeout.Consume]?: number
    [StreamTimeout.Pull]?: number
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

  protected createRpcContext(
    connection: GatewayConnection,
    messageContext: ReturnType<typeof this.createMessageContext>,
    gatewayRpc: GatewayRpc,
    signal?: AbortSignal,
  ): GatewayRpcContext {
    const { callId, payload, procedure, metadata } = gatewayRpc
    const controller = new AbortController()
    connection.rpcs.set(gatewayRpc.callId, controller)
    signal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal

    const container = connection.container.fork(Scope.Call)

    const dispose = async () => {
      const streamAbortReason = 'Stream is not consumed by a user'

      for (const streamId of connection.clientStreams.findByCall(callId)) {
        connection.clientStreams.abort(streamId, streamAbortReason)
        messageContext.transport.send?.(
          connection.id,
          messageContext.protocol.encodeMessage(
            messageContext,
            ServerMessageType.ClientStreamAbort,
            { streamId, reason: streamAbortReason },
          ),
        )
      }

      await container.dispose()

      connection.rpcs.remove(gatewayRpc.callId)
    }

    return {
      ...messageContext,
      callId,
      payload,
      procedure,
      metadata,
      container,
      signal,
      [Symbol.asyncDispose]: dispose,
    }
  }

  protected createMessageContext(
    connection: GatewayConnection,
    transportKey: string,
  ) {
    const transport = this.options.transports[transportKey].transport
    const {
      id: connectionId,
      protocol,
      decoder,
      encoder,
      clientStreams,
      serverStreams,
    } = connection

    return {
      connectionId,
      protocol,
      encoder,
      decoder,
      transport,
      streamId: connection.getStreamId,
      addClientStream({ streamId, callId, metadata }) {
        const stream = clientStreams.add(callId, streamId, metadata, {
          destroy(error, callback) {
            console.trace('Client stream destroyed', { streamId, error })
            callback()
          },
          read: (size) => {
            transport.send?.(
              connectionId,
              protocol.encodeMessage(this, ServerMessageType.ClientStreamPull, {
                streamId,
                size: size || 65535 /* 64kb */,
              }),
            )
          },
        })

        return () => {
          clientStreams.consume(callId, streamId)
          return stream
        }
      },
      addServerStream({ blob, callId, streamId }) {
        const stream = serverStreams.add(callId, streamId, blob)
        stream.on('data', (chunk) => {
          stream.pause()
          const buf = Buffer.from(chunk)
          this.transport.send?.(
            this.connectionId,
            this.protocol.encodeMessage(
              this,
              ServerMessageType.ServerStreamPush,
              { streamId, chunk: buf },
            ),
          )
        })
        stream.on('error', (error) => {
          this.transport.send?.(
            this.connectionId,
            this.protocol.encodeMessage(
              this,
              ServerMessageType.ServerStreamAbort,
              { streamId, reason: error.message },
            ),
          )
        })
        stream.on('end', () => {
          this.transport.send?.(
            this.connectionId,
            this.protocol.encodeMessage(
              this,
              ServerMessageType.ServerStreamEnd,
              { streamId },
            ),
          )
        })

        return stream
      },
    } satisfies ProtocolMessageContext & { [key: string]: unknown }
  }

  protected onConnect(transport: string): TransportWorkerParams['onConnect'] {
    return async (options, ...injections) => {
      const protocol = versions[options.protocolVersion]
      if (!protocol) throw new Error('Unsupported protocol version')
      const id = randomUUID()
      const container = this.options.container.fork(Scope.Connection)
      const clientStreams = new GatewayConnectionClientStreams()
      const serverStreams = new GatewayConnectionServerStreams(
        this.options.streamTimeouts,
      )
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
          clientStreams,
          serverStreams,
        })

        await container.provide(injectables.connection, connection)

        const dispose = this.onDisconnect(transport).bind(this, {
          connectionId: connection.id,
        })

        return Object.assign(connection, { [Symbol.asyncDispose]: dispose })
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
      console.debug(`Disconnecting [${transport}] connection`)
      await this.connections.close(connectionId)
    }
  }

  protected onMessage(transport: string): TransportWorkerParams['onMessage'] {
    return async ({ connectionId, data }, ...injections) => {
      try {
        const connection = this.connections.get(connectionId)
        assert(connection, 'Connection not found')
        const messageContext = this.createMessageContext(connection, transport)
        const message = messageContext.protocol.decodeMessage(
          messageContext,
          Buffer.from(data),
        )
        this.options.logger.trace({ type: message.type }, 'Received message')
        switch (message.type) {
          case ClientMessageType.Rpc: {
            await using rpcContext = this.createRpcContext(
              connection,
              messageContext,
              message.rpc,
            )
            await rpcContext.container.provide(injections)
            await this.handleRpc(connection, rpcContext)
            break
          }
          case ClientMessageType.RpcAbort: {
            const controller = connection.rpcs.get(message.callId)
            controller?.abort()
            break
          }
          case ClientMessageType.ClientStreamAbort: {
            connection.clientStreams.abort(message.streamId, message.reason)
            break
          }
          case ClientMessageType.ClientStreamPush: {
            connection.clientStreams.push(message.streamId, message.chunk)
            break
          }
          case ClientMessageType.ClientStreamEnd: {
            connection.clientStreams.end(message.streamId)
            break
          }
          case ClientMessageType.ServerStreamAbort: {
            connection.serverStreams.abort(message.streamId, message.reason)
            break
          }
          case ClientMessageType.ServerStreamPull: {
            connection.serverStreams.pull(message.streamId)
            break
          }
          default: {
            throw new Error('Unknown message type')
          }
        }
      } catch (error) {
        this.options.logger.trace({ error }, 'Error handling message')
      }
    }
  }

  protected onRpc(transport: string): TransportWorkerParams['onRpc'] {
    return async (connection, rpc, signal, ...injections) => {
      const messageContext = this.createMessageContext(
        connection,
        connection.transport,
      )
      await using rpcContext = this.createRpcContext(
        connection,
        messageContext,
        rpc,
        signal,
      )
      await rpcContext.container.provide(injections)
      return await this.options.api.call({
        connection,
        container: rpcContext.container,
        payload: rpc.payload,
        procedure: rpc.procedure,
        metadata: rpc.metadata,
        signal: rpcContext.signal,
      })
    }
  }

  protected async handleRpc(
    connection: GatewayConnection,
    context: GatewayRpcContext,
  ): Promise<void> {
    const {
      container,
      connectionId,
      encoder,
      transport,
      protocol,
      signal,
      callId,
      procedure,
      payload,
    } = context
    try {
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
          if (!isAbortError(error)) {
            this.options.logger.error(error)
          }
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
      const level = error instanceof ProtocolError ? 'trace' : 'error'
      this.options.logger[level](error)
    }
  }
}
