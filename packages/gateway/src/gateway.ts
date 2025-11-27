import assert from 'node:assert'
import { randomUUID } from 'node:crypto'

import type { Container, Hooks, Injection, Logger } from '@nmtjs/core'
import type { ProtocolRPCPayload } from '@nmtjs/protocol'
import type {
  ProtocolFormats,
  MessageContext as ProtocolMessageContext,
} from '@nmtjs/protocol/server'
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
import type {
  ConnectionIdentityResolver,
  GatewayMessageContext,
} from './types.ts'
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

  protected createRpcMessageContext(
    connection: GatewayConnection,
    messageContext: ReturnType<typeof this.createProtocolMessageContext>,
    callId: number,
  ): GatewayMessageContext {
    const { rpcs, container } = connection
    const rpc = rpcs.get(callId)!
    return { ...messageContext, callId, container, rpc }
  }

  protected createProtocolMessageContext(
    connection: GatewayConnection,
    transportKey: string,
  ) {
    const clientStreams = new ProtocolClientStreams(connection.clientStreams)
    const serverStreams = new ProtocolServerStreams(connection.serverStreams)
    const transport = this.options.transports[transportKey].transport
    const { id: connectionId, protocol, rpcs, decoder, encoder } = connection

    return {
      clientStreams,
      serverStreams,
      connectionId,
      protocol,
      encoder,
      decoder,
      transport,
      streamId: connection.getStreamId,
      addClientStream({ streamId, callId, metadata, pull }) {
        const stream = clientStreams.add(streamId, metadata, pull)
        const rpc = rpcs.get(callId)
        if (rpc) rpc.clientStreams.add(streamId)
        return () => {
          if (rpc) {
            rpc.clientStreams.delete(streamId)
          }
          return stream
        }
      },
      addServerStream({ blob, callId, streamId }) {
        const stream = serverStreams.add(streamId, blob)
        const rpc = connection.rpcs.get(callId)
        if (rpc) rpc.serverStreams.add(streamId)
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
      const messageContext = this.createProtocolMessageContext(
        connection,
        transport,
      )
      const message = messageContext.protocol.decodeMessage(
        messageContext,
        Buffer.from(data),
      )
      switch (message.type) {
        case ClientMessageType.Rpc: {
          const rpcContext = this.createRpcMessageContext(
            connection,
            messageContext,
            message.rpc.callId,
          )
          try {
            await this.handleRpc(
              connection,
              rpcContext,
              message.rpc,
              injections,
            )
          } finally {
            for (const element of rpcContext.rpc.clientStreams) {
            }
          }
          break
        }
        case ClientMessageType.RpcAbort: {
          const rpc = connection.rpcs.get(message.callId)
          if (rpc) rpc.controller.abort()
          break
        }
        case ClientMessageType.ClientStreamAbort: {
          messageContext.clientStreams.abort(message.streamId, message.reason)
          break
        }
        case ClientMessageType.ClientStreamPush: {
          messageContext.clientStreams.push(message.streamId, message.chunk)
          break
        }
        case ClientMessageType.ClientStreamEnd: {
          messageContext.clientStreams.end(message.streamId)
          break
        }
        case ClientMessageType.ServerStreamAbort: {
          messageContext.serverStreams.abort(message.streamId, message.reason)
          break
        }
        case ClientMessageType.ServerStreamPull: {
          messageContext.serverStreams.pull(message.streamId)
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
      connection.rpcs.set(rpc.callId, {
        controller,
        clientStreams: new Set(),
        serverStreams: new Set(),
      })
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
    context: GatewayMessageContext,
    rpc: ProtocolRPCPayload,
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
    rpcs.set(rpc.callId, {
      controller,
      clientStreams: new Set(),
      serverStreams: new Set(),
    })
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
