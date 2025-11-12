import type { MessagePort } from 'node:worker_threads'
import assert from 'node:assert'

import type {
  AnyInjectable,
  Container,
  Hooks,
  Injection,
  Logger,
} from '@nmtjs/core'
import type { ProtocolRPC } from '@nmtjs/protocol'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { isAbortError } from '@nmtjs/common'
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

import type { ProtocolApi, ProtocolApiCallOptions } from './api.ts'
import type { GatewayConnection } from './connection.ts'
import type { TransportV2Worker, TransportV2WorkerHooks } from './transport.ts'
import type { ConnectionIndentityResolver } from './types.ts'
import type { MessageContext } from './utils.ts'
import { isIterable } from './api.ts'
import { GatewayConnections } from './connections.ts'

export interface GatewayOptions {
  identityResolver: AnyInjectable<ConnectionIndentityResolver, Scope.Connection>
  transports: {
    [key: string]: {
      port?: MessagePort
      worker: TransportV2Worker
      options: any
    }
  }
}

export class Gateway {
  connections: GatewayConnections

  constructor(
    protected runtime: {
      logger: Logger
      container: Container
      hooks: Hooks
      formats: ProtocolFormats
      api: ProtocolApi
    },
    protected options: GatewayOptions,
  ) {
    this.connections = new GatewayConnections({
      logger: this.runtime.logger,
      container: this.runtime.container,
      hooks: this.runtime.hooks,
      formats: this.runtime.formats,
    })
  }

  async start() {
    for (const key in this.options.transports) {
      const { worker, options, port } = this.options.transports[key]
      const host = await worker.start({
        onConnect: this.onConnect(key),
        onDisconnect: this.onDisconnect(key),
        onMessage: this.onMessage(key),
        onRpc: this.onRpc,
        options,
        port,
      })
      this.runtime.logger.info(`Transport [${key}] started on [${host}]`)
    }
  }

  async stop() {
    for (const key in this.options.transports) {
      const { options, worker, port } = this.options.transports[key]
      await worker.stop({
        onConnect: this.onConnect(key),
        onDisconnect: this.onDisconnect(key),
        onMessage: this.onMessage(key),
        onRpc: this.onRpc,
        options,
        port,
      })
      this.runtime.logger.info(`Transport [${key}] stopped`)
    }
  }

  send(transport: string, connectionId: string, data: ArrayBuffer) {
    if (transport in this.options.transports) {
      const send = this.options.transports[transport].worker.send
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
      transport: this.options.transports[transport].worker,
      container: connection.container,
      streamId: connection.getStreamId,
    }
  }

  protected onConnect(transport: string): TransportV2WorkerHooks['onConnect'] {
    return async (options, ...injections) => {
      const protocol = versions[options.protocolVersion]
      if (!protocol) throw new Error('Unsupported protocol version')
      const container = this.runtime.container.fork(Scope.Connection)
      for (const { token, value } of injections) {
        container.provide(token, value)
      }
      const resolver = await container.resolve(this.options.identityResolver)
      const identity = await resolver()
      const { id } = await this.connections.open({
        container,
        identity,
        transport,
        protocol,
        options,
      })
      return { connectionId: id }
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
          await this.handleRpc(context, message.rpc, injections)
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

  protected async callApi(options: ProtocolApiCallOptions) {
    try {
      return await this.runtime.api.call(options)
    } catch (error) {
      if (error instanceof ProtocolError === false) {
        this.runtime.logger.error({ error }, 'Error during RPC call')
        throw new ProtocolError(
          ErrorCode.InternalServerError,
          'Internal server error',
        )
      }
      throw error
    }
  }

  protected async handleRpc(
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
        container,
        payload,
        procedure,
        signal,
        // validateMetadata: params.validateMetadata,
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
          this.runtime.logger.error(error)
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
