import { randomUUID } from 'node:crypto'
import { isTypedArray } from 'node:util/types'

import type {
  Container,
  Hooks,
  Logger,
  LoggerChildOptions,
  ResolveInjectableType,
} from '@nmtjs/core'
import type {
  ClientStreamConsumer,
  ProtocolFormats,
  MessageContext as ProtocolMessageContext,
} from '@nmtjs/protocol/server'
import { anyAbortSignal, isAbortError } from '@nmtjs/common'
import { createFactoryInjectable, provision, Scope } from '@nmtjs/core'
import {
  ClientMessageType,
  isBlobInterface,
  kBlobKey,
  ProtocolBlob,
  ServerMessageType,
} from '@nmtjs/protocol'
import { getFormat, ProtocolError, versions } from '@nmtjs/protocol/server'

import type { GatewayApi } from './api.ts'
import type { GatewayConnection } from './connections.ts'
import type { ProxyableTransportType } from './enums.ts'
import type { StreamConfig } from './streams.ts'
import type { TransportWorker, TransportWorkerParams } from './transport.ts'
import type {
  ConnectionIdentity,
  GatewayRpc,
  GatewayRpcContext,
} from './types.ts'
import { ConnectionManager } from './connections.ts'
import { StreamTimeout } from './enums.ts'
import * as injectables from './injectables.ts'
import { RpcManager } from './rpcs.ts'
import { BlobStreamsManager } from './streams.ts'

export interface GatewayOptions {
  logger: Logger
  container: Container
  hooks: Hooks
  formats: ProtocolFormats
  api: GatewayApi
  transports: {
    [key: string]: {
      transport: TransportWorker
      proxyable?: ProxyableTransportType
    }
  }
  identity?: ConnectionIdentity
  rpcStreamConsumeTimeout?: number
  streamTimeouts?: Partial<StreamConfig['timeouts']>
}

export class Gateway {
  readonly logger: Logger
  readonly connections: ConnectionManager
  readonly rpcs: RpcManager
  readonly blobStreams: BlobStreamsManager
  public options: Required<
    Omit<GatewayOptions, 'streamTimeouts'> & {
      streamTimeouts: Required<
        Exclude<GatewayOptions['streamTimeouts'], undefined>
      >
    }
  >

  constructor(options: GatewayOptions) {
    this.options = {
      rpcStreamConsumeTimeout: 5000,
      streamTimeouts: {
        //@ts-expect-error
        [StreamTimeout.Pull]:
          options.streamTimeouts?.[StreamTimeout.Pull] ?? 5000,
        //@ts-expect-error
        [StreamTimeout.Consume]:
          options.streamTimeouts?.[StreamTimeout.Consume] ?? 5000,
        //@ts-expect-error
        [StreamTimeout.Finish]:
          options.streamTimeouts?.[StreamTimeout.Finish] ?? 10000,
      },
      ...options,
      identity:
        options.identity ??
        createFactoryInjectable({
          dependencies: { connectionId: injectables.connectionId },
          factory: ({ connectionId }) => connectionId,
        }),
    }
    this.logger = options.logger.child({}, gatewayLoggerOptions)
    this.connections = new ConnectionManager()
    this.rpcs = new RpcManager()
    this.blobStreams = new BlobStreamsManager({
      timeouts: this.options.streamTimeouts,
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
      this.logger.info(`Transport [${key}] started on [${url}]`)
      if (proxyable) hosts.push({ url, type: proxyable })
    }
    return hosts
  }

  async stop() {
    // Close all connections
    for (const connection of this.connections.getAll()) {
      await this.closeConnection(connection.id)
    }

    for (const key in this.options.transports) {
      const { transport } = this.options.transports[key]
      await transport.stop({ formats: this.options.formats })
      this.logger.debug(`Transport [${key}] stopped`)
    }
  }

  send(transport: string, connectionId: string, data: ArrayBufferView) {
    if (transport in this.options.transports) {
      const transportInstance = this.options.transports[transport].transport
      if (transportInstance.send) {
        return transportInstance.send(connectionId, data)
      }
    }
  }

  async reload() {
    for (const connections of this.connections.connections.values()) {
      await connections.container.dispose()
    }
  }

  protected createRpcContext(
    connection: GatewayConnection,
    messageContext: ReturnType<typeof this.createMessageContext>,
    logger: Logger,
    gatewayRpc: GatewayRpc,
    signal?: AbortSignal,
  ): GatewayRpcContext {
    const { callId, payload, procedure, metadata } = gatewayRpc
    const controller = new AbortController()
    this.rpcs.set(connection.id, callId, controller)

    signal = signal
      ? anyAbortSignal(signal, controller.signal)
      : controller.signal

    const container = connection.container.fork(Scope.Call)

    const dispose = async () => {
      const streamAbortReason = 'Stream is not consumed by a user'

      // Abort streams related to this call
      this.blobStreams.abortClientCallStreams(
        connection.id,
        callId,
        streamAbortReason,
      )

      this.rpcs.delete(connection.id, callId)
      this.rpcs.releasePull(connection.id, callId)

      await container.dispose()
    }

    return {
      ...messageContext,
      callId,
      payload,
      procedure,
      metadata,
      container,
      signal,
      logger: logger.child({ callId, procedure }),
      [Symbol.asyncDispose]: dispose,
    }
  }

  protected createMessageContext(
    connection: GatewayConnection,
    transportKey: string,
  ) {
    const transport = this.options.transports[transportKey].transport
    const { id: connectionId, protocol, decoder, encoder } = connection

    const streamId = this.connections.getStreamId.bind(
      this.connections,
      connectionId,
    )

    return {
      connectionId,
      protocol,
      encoder,
      decoder,
      transport,
      streamId,
      addClientStream: ({ streamId, callId, metadata }) => {
        const stream = this.blobStreams.createClientStream(
          connectionId,
          callId,
          streamId,
          metadata,
          {
            read: (size) => {
              transport.send!(
                connectionId,
                protocol.encodeMessage(
                  this.createMessageContext(connection, transportKey),
                  ServerMessageType.ClientStreamPull,
                  { streamId, size: size || 65535 },
                ),
              )
            },
          },
        )

        stream.once('error', () => {
          this.send(
            transportKey,
            connectionId,
            protocol.encodeMessage(
              this.createMessageContext(connection, transportKey),
              ServerMessageType.ClientStreamAbort,
              { streamId },
            ),
          )
        })

        const consume = () => {
          this.blobStreams.consumeClientStream(connectionId, callId, streamId)
          return stream
        }

        const consumer = Object.defineProperties(consume, {
          [kBlobKey]: {
            enumerable: false,
            configurable: false,
            writable: false,
            value: true,
          },
          metadata: {
            value: metadata,
            enumerable: true,
            configurable: false,
            writable: false,
          },
        }) as ClientStreamConsumer

        return consumer
      },
    } satisfies ProtocolMessageContext & { [key: string]: unknown }
  }

  protected onConnect(transport: string): TransportWorkerParams['onConnect'] {
    const logger = this.logger.child({ transport })
    return async (options, ...injections) => {
      logger.debug('Initiating new connection')

      const protocol = versions[options.protocolVersion]
      if (!protocol) throw new Error('Unsupported protocol version')

      const id = randomUUID()
      const container = this.options.container.fork(Scope.Connection)

      try {
        container.provide([
          provision(injectables.connectionData, options.data),
          provision(injectables.connectionId, id),
        ])
        container.provide(injections)

        const identity = await container.resolve(this.options.identity)

        const { accept, contentType, type } = options
        const { decoder, encoder } = getFormat(this.options.formats, {
          accept,
          contentType,
        })

        const abortController = new AbortController()

        const connection: GatewayConnection = {
          id,
          type,
          identity,
          transport,
          protocol,
          container,
          encoder,
          decoder,
          abortController,
        }

        this.connections.add(connection)

        container.provide(
          injectables.connectionAbortSignal,
          abortController.signal,
        )

        logger.debug(
          {
            id,
            protocol: options.protocolVersion,
            type,
            accept,
            contentType,
            identity,
            transportData: options.data,
          },
          'Connection established',
        )

        return Object.assign(connection, {
          [Symbol.asyncDispose]: async () => {
            await this.onDisconnect(transport)(connection.id)
          },
        })
      } catch (error) {
        logger.debug({ error }, 'Error establishing connection')
        container.dispose()
        throw error
      }
    }
  }

  protected onDisconnect(
    transport: string,
  ): TransportWorkerParams['onDisconnect'] {
    const logger = this.logger.child({ transport })
    return async (connectionId) => {
      logger.debug({ connectionId }, 'Disconnecting connection')
      await this.closeConnection(connectionId)
    }
  }

  protected onMessage(transport: string): TransportWorkerParams['onMessage'] {
    const _logger = this.logger.child({ transport })

    return async ({ connectionId, data }, ...injections) => {
      const logger = _logger.child({ connectionId })
      try {
        const connection = this.connections.get(connectionId)
        const messageContext = this.createMessageContext(connection, transport)

        const message = connection.protocol.decodeMessage(
          messageContext,
          Buffer.from(data),
        )

        logger.trace(message, 'Received message')

        switch (message.type) {
          case ClientMessageType.Rpc: {
            const rpcContext = this.createRpcContext(
              connection,
              messageContext,
              logger,
              message.rpc,
            )
            try {
              await rpcContext.container.provide([
                ...injections,
                provision(
                  injectables.createBlob,
                  this.createBlobFunction(rpcContext),
                ),
              ])
              await this.handleRpcMessage(connection, rpcContext)
            } finally {
              await rpcContext[Symbol.asyncDispose]()
            }
            break
          }
          case ClientMessageType.RpcPull: {
            this.rpcs.releasePull(connectionId, message.callId)
            break
          }
          case ClientMessageType.RpcAbort: {
            this.rpcs.abort(connectionId, message.callId)
            break
          }
          case ClientMessageType.ClientStreamAbort: {
            this.blobStreams.abortClientStream(
              connectionId,
              message.streamId,
              message.reason,
            )
            break
          }
          case ClientMessageType.ClientStreamPush: {
            this.blobStreams.pushToClientStream(
              connectionId,
              message.streamId,
              message.chunk,
            )
            break
          }
          case ClientMessageType.ClientStreamEnd: {
            this.blobStreams.endClientStream(connectionId, message.streamId)
            break
          }
          case ClientMessageType.ServerStreamAbort: {
            this.blobStreams.abortServerStream(
              connectionId,
              message.streamId,
              message.reason,
            )
            break
          }
          case ClientMessageType.ServerStreamPull: {
            this.blobStreams.pullServerStream(connectionId, message.streamId)
            break
          }
          default:
            throw new Error('Unknown message type')
        }
      } catch (error) {
        logger.trace({ error }, 'Error handling message')
        throw error
      }
    }
  }

  protected onRpc(transport: string): TransportWorkerParams['onRpc'] {
    const _logger = this.logger.child({ transport })
    return async (connection, rpc, signal, ...injections) => {
      const logger = _logger.child({ connectionId: connection.id })
      const messageContext = this.createMessageContext(
        connection,
        connection.transport,
      )
      const rpcContext = this.createRpcContext(
        connection,
        messageContext,
        logger,
        rpc,
        signal,
      )
      try {
        await rpcContext.container.provide([
          ...injections,
          provision(injectables.rpcAbortSignal, signal),
          provision(
            injectables.createBlob,
            this.createBlobFunction(rpcContext),
          ),
        ])

        const result = await this.options.api.call({
          connection,
          payload: rpc.payload,
          procedure: rpc.procedure,
          metadata: rpc.metadata,
          container: rpcContext.container,
          signal: rpcContext.signal,
        })

        if (typeof result === 'function') {
          return result(async () => {
            await rpcContext[Symbol.asyncDispose]()
          })
        } else {
          await rpcContext[Symbol.asyncDispose]()
          return result
        }
      } catch (error) {
        await rpcContext[Symbol.asyncDispose]()
        throw error
      }
    }
  }

  protected async handleRpcMessage(
    connection: GatewayConnection,
    context: GatewayRpcContext,
  ): Promise<void> {
    const {
      container,
      connectionId,
      transport,
      protocol,
      signal,
      callId,
      procedure,
      payload,
      encoder,
    } = context
    try {
      container.provide(injectables.rpcAbortSignal, signal)
      const response = await this.options.api.call({
        connection: connection as any,
        container,
        payload,
        procedure,
        signal,
      })

      if (typeof response === 'function') {
        transport.send!(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.RpcStreamResponse, {
            callId,
          }),
        )

        try {
          const consumeTimeoutSignal = this.options.rpcStreamConsumeTimeout
            ? AbortSignal.timeout(this.options.rpcStreamConsumeTimeout)
            : undefined

          const streamSignal = consumeTimeoutSignal
            ? anyAbortSignal(signal, consumeTimeoutSignal)
            : signal

          await this.rpcs.awaitPull(connectionId, callId, streamSignal)

          for await (const chunk of response()) {
            signal.throwIfAborted()
            const chunkEncoded = encoder.encode(chunk)
            transport.send!(
              connectionId,
              protocol.encodeMessage(
                context,
                ServerMessageType.RpcStreamChunk,
                { callId, chunk: chunkEncoded },
              ),
            )
            await this.rpcs.awaitPull(connectionId, callId)
          }

          transport.send!(
            connectionId,
            protocol.encodeMessage(context, ServerMessageType.RpcStreamEnd, {
              callId,
            }),
          )
        } catch (error) {
          if (!isAbortError(error)) {
            this.logger.error(error)
          }
          transport.send!(
            connectionId,
            protocol.encodeMessage(context, ServerMessageType.RpcStreamAbort, {
              callId,
            }),
          )
        }
      } else {
        const streams = this.blobStreams.getServerStreamsMetadata(
          connectionId,
          callId,
        )
        transport.send!(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.RpcResponse, {
            callId,
            result: response,
            streams,
            error: null,
          }),
        )
      }
    } catch (error) {
      transport.send!(
        connectionId,
        protocol.encodeMessage(context, ServerMessageType.RpcResponse, {
          callId,
          result: null,
          streams: {},
          error,
        }),
      )
      const level = error instanceof ProtocolError ? 'trace' : 'error'
      this.logger[level](error)
    }
  }

  protected async closeConnection(connectionId: string) {
    if (this.connections.has(connectionId)) {
      const connection = this.connections.get(connectionId)
      connection.abortController.abort()
      connection.container.dispose()
    }

    this.rpcs.close(connectionId)
    this.blobStreams.cleanupConnection(connectionId)
    this.connections.remove(connectionId)
  }

  protected createBlobFunction(
    context: GatewayRpcContext,
  ): ResolveInjectableType<typeof injectables.createBlob> {
    const {
      streamId: getStreamId,
      transport,
      protocol,
      connectionId,
      callId,
      encoder,
    } = context

    return (source, metadata) => {
      const streamId = getStreamId()
      const blob = ProtocolBlob.from(source, metadata, () => {
        return encoder.encodeBlob(streamId)
      })
      const stream = this.blobStreams.createServerStream(
        connectionId,
        callId,
        streamId,
        blob,
      )

      stream.on('data', (chunk) => {
        transport.send!(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.ServerStreamPush, {
            streamId: streamId,
            chunk: Buffer.from(chunk),
          }),
        )
      })

      stream.on('error', (error) => {
        transport.send!(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.ServerStreamAbort, {
            streamId: streamId,
            reason: error.message,
          }),
        )
      })

      stream.once('finish', () => {
        transport.send!(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.ServerStreamEnd, {
            streamId: streamId,
          }),
        )
      })

      stream.once('close', () => {
        this.blobStreams.removeServerStream(connectionId, streamId)
      })

      return blob
    }
  }
}

const gatewayLoggerOptions: LoggerChildOptions = {
  serializers: {
    chunk: (chunk) =>
      isTypedArray(chunk) ? `<Buffer length=${chunk.byteLength}>` : chunk,
    payload: (payload) => {
      function traverseObject(obj: any): any {
        if (Array.isArray(obj)) {
          return obj.map(traverseObject)
        } else if (isTypedArray(obj)) {
          return `<${obj.constructor.name} length=${obj.byteLength}>`
        } else if (typeof obj === 'object' && obj !== null) {
          const result: Record<string, any> = {}
          for (const [key, value] of Object.entries(obj)) {
            result[key] = traverseObject(value)
          }
          return result
        } else if (isBlobInterface(obj)) {
          return `<ClientBlobStream metadata=${JSON.stringify(obj.metadata)}>`
        }
        return obj
      }
      return traverseObject(payload)
    },
    headers: (value) => {
      if (value instanceof Headers) {
        const obj: Record<string, any> = {}
        value.forEach((v, k) => {
          obj[k] = v
        })
        return obj
      }
      return value
    },
  },
}
