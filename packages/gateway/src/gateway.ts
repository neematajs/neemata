import { randomUUID } from 'node:crypto'
import { isTypedArray } from 'node:util/types'

import type {
  ChildLoggerOptions,
  Container,
  Hooks,
  Logger,
  Provision,
  ResolveInjectableType,
} from '@nmtjs/core'
import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import type {
  ProtocolFormats,
  MessageContext as ProtocolMessageContext,
} from '@nmtjs/protocol/server'
import {
  anyAbortSignal,
  createFuture,
  isAbortError,
  noopFn,
  withTimeout,
} from '@nmtjs/common'
import {
  createFactoryInjectable,
  forkLogger,
  provision,
  Scope,
} from '@nmtjs/core'
import {
  ClientMessageType,
  ConnectionType,
  createProtocolBlobReference,
  getProtocolBlobStreamId,
  isBlobInterface,
  ProtocolBlob,
  ServerMessageType,
} from '@nmtjs/protocol'
import { getFormat, ProtocolError, versions } from '@nmtjs/protocol/server'

import type { GatewayApi, GatewayResolvedProcedure } from './api.ts'
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

export interface GatewayOptions<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  logger: Logger
  container: Container
  hooks: Hooks
  formats: ProtocolFormats
  api: GatewayApi<ResolvedProcedure>
  transports: {
    [key: string]: {
      transport: TransportWorker<ConnectionType, ResolvedProcedure>
      proxyable?: ProxyableTransportType
    }
  }
  identity?: ConnectionIdentity
  streamTimeouts?: Partial<StreamConfig['timeouts']>

  /**
   * Server-initiated heartbeat for bidirectional connections.
   * When enabled, gateway periodically sends protocol Ping and expects Pong.
   */
  heartbeat?: false | { interval?: number; timeout?: number }
}

const DEFAULT_GATEWAY_HEARTBEAT_INTERVAL = 15000
const DEFAULT_GATEWAY_HEARTBEAT_TIMEOUT = 5000
/**
 * Upper bound per connection teardown step so a never-settling transport
 * close or container disposal can't hang closeConnection() and stop().
 */
export const GATEWAY_TEARDOWN_STEP_TIMEOUT = 10_000

export class Gateway<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  readonly logger: Logger
  readonly connections: ConnectionManager
  readonly rpcs: RpcManager
  readonly blobStreams: BlobStreamsManager
  private readonly heartbeat = new Map<
    string,
    {
      abortController: AbortController
      pending: Map<number, ReturnType<typeof createFuture<void>>>
      nonce: number
    }
  >()
  // In-flight teardowns keyed by connection id, see closeConnection
  private readonly closingConnections = new Map<string, Promise<void>>()
  public options: Required<
    Omit<GatewayOptions<ResolvedProcedure>, 'streamTimeouts'> & {
      streamTimeouts: Required<
        Exclude<GatewayOptions<ResolvedProcedure>['streamTimeouts'], undefined>
      >
    }
  >

  constructor(options: GatewayOptions<ResolvedProcedure>) {
    this.options = {
      heartbeat: {
        interval: DEFAULT_GATEWAY_HEARTBEAT_INTERVAL,
        timeout: DEFAULT_GATEWAY_HEARTBEAT_TIMEOUT,
      },
      ...options,
      streamTimeouts: {
        [StreamTimeout.Pull]: 15000,
        [StreamTimeout.Consume]: 15000,
        [StreamTimeout.Finish]: 120000,
        ...options.streamTimeouts,
      },
      identity:
        options.identity ??
        createFactoryInjectable({
          dependencies: { connectionId: injectables.connectionId },
          create: ({ connectionId }) => connectionId,
        }),
    }
    this.logger = forkLogger(options.logger, undefined, gatewayLoggerOptions)
    this.connections = new ConnectionManager()
    this.rpcs = new RpcManager()
    this.blobStreams = new BlobStreamsManager({
      timeouts: this.options.streamTimeouts,
    })
  }

  async start() {
    const hosts: { url: string; type: ProxyableTransportType }[] = []
    for (const transportKey in this.options.transports) {
      const { transport, proxyable } = this.options.transports[transportKey]
      const url = await transport.start({
        formats: this.options.formats,
        onConnect: this.onConnect(transportKey),
        onDisconnect: this.onDisconnect(transportKey),
        onMessage: this.onMessage(transportKey),
        resolve: this.resolve(transportKey),
        onRpc: this.onRpc(transportKey),
      })
      this.logger.info(`Transport [${transportKey}] started on [${url}]`)
      if (proxyable) hosts.push({ url, type: proxyable })
    }
    return hosts
  }

  private resolveHeartbeatConfig() {
    if (this.options.heartbeat === false) return null
    if (!this.options.heartbeat) return null
    return {
      interval:
        this.options.heartbeat.interval ?? DEFAULT_GATEWAY_HEARTBEAT_INTERVAL,
      timeout:
        this.options.heartbeat.timeout ?? DEFAULT_GATEWAY_HEARTBEAT_TIMEOUT,
    }
  }

  private startHeartbeat(connection: GatewayConnection) {
    const config = this.resolveHeartbeatConfig()
    if (!config) return
    if (connection.type !== ConnectionType.Bidirectional) return
    if (this.heartbeat.has(connection.id)) return

    const abortController = new AbortController()
    const signal = anyAbortSignal(
      connection.abortController.signal,
      abortController.signal,
    )

    const state = {
      abortController,
      pending: new Map<number, ReturnType<typeof createFuture<void>>>(),
      nonce: 0,
    }
    this.heartbeat.set(connection.id, state)

    const transportWorker =
      this.options.transports[connection.transport]?.transport
    const loop = async () => {
      while (!signal.aborted && this.connections.has(connection.id)) {
        await new Promise((resolve) => setTimeout(resolve, config.interval))
        if (signal.aborted || !this.connections.has(connection.id)) break

        const ctx = this.createMessageContext(connection, connection.transport)
        const nonce = state.nonce++

        const future = createFuture<void>()
        state.pending.set(nonce, future)

        try {
          transportWorker.send?.(
            connection.id,
            connection.protocol.encodeMessage(ctx, ServerMessageType.Ping, {
              nonce,
            }),
          )

          await withTimeout(
            future.promise,
            config.timeout,
            new Error('Heartbeat timeout'),
          )
        } catch {
          state.pending.delete(nonce)
          // Route through the single claimed teardown so the transport is
          // closed exactly once even when a disconnect races in
          await this.closeConnection(connection.id, {
            code: 1001,
            reason: 'heartbeat_timeout',
          })
          break
        }
      }
    }

    loop().catch(noopFn)
  }

  private stopHeartbeat(connectionId: string, reason?: any) {
    const state = this.heartbeat.get(connectionId)
    if (!state) return
    this.heartbeat.delete(connectionId)
    state.abortController.abort(reason)

    if (state.pending.size) {
      const error = new Error('Heartbeat stopped', { cause: reason })
      for (const pending of state.pending.values()) pending.reject(error)
      state.pending.clear()
    }
  }

  async stop() {
    // Close all connections
    for (const connection of this.connections.getAll()) {
      await this.closeConnection(connection.id)
    }

    // Also wait for teardowns already claimed by concurrent callers
    // (e.g. transport disconnect) — they are no longer in the map
    await Promise.all(this.closingConnections.values())

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

  async reload(
    options?: Pick<
      GatewayOptions<ResolvedProcedure>,
      'api' | 'container' | 'hooks' | 'identity'
    >,
  ) {
    // Own the hot-swap of these options internally so callers don't reach into
    // `this.options` directly; identity falls back to the current one.
    if (options) {
      this.options.api = options.api
      this.options.container = options.container
      this.options.hooks = options.hooks
      this.options.identity = options.identity ?? this.options.identity
    }

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
    const { callId, payload, procedure } = gatewayRpc
    const controller = new AbortController()
    this.rpcs.set(connection.id, callId, controller)

    signal = signal
      ? anyAbortSignal(signal, controller.signal)
      : controller.signal

    const container = connection.container.fork(Scope.Call)

    const dispose = async () => {
      const streamAbortReason = 'Blob was not consumed before handler completed'

      const unconsumedStreamIds = this.blobStreams.getClientCallStreamIds(
        connection.id,
        callId,
      )

      for (const streamId of unconsumedStreamIds) {
        messageContext.transport.send?.(
          connection.id,
          connection.protocol.encodeMessage(
            messageContext,
            ServerMessageType.ClientStreamAbort,
            { streamId, reason: streamAbortReason },
          ),
        )
      }

      // Abort streams related to this call
      this.blobStreams.abortClientCallStreams(
        connection.id,
        callId,
        streamAbortReason,
      )

      this.rpcs.delete(connection.id, callId)

      await container.dispose()
    }

    return {
      ...messageContext,
      connectionType: connection.type,
      callId,
      payload,
      procedure,
      container,
      signal,
      logger: forkLogger(logger, undefined, undefined, { callId, procedure }),
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

        return createProtocolBlobReference(streamId, metadata)
      },
    } satisfies ProtocolMessageContext & { [key: string]: unknown }
  }

  protected onConnect(transport: string): TransportWorkerParams['onConnect'] {
    const logger = forkLogger(this.logger, undefined, undefined, { transport })
    return async (options, ...injections) => {
      logger.trace('Initiating new connection')

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

        this.startHeartbeat(connection)

        container.provide([
          provision(injectables.connection, connection),
          provision(injectables.connectionAbortSignal, abortController.signal),
        ])

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
        logger.error({ error }, 'Error establishing connection')
        await container.dispose()
        throw error
      }
    }
  }

  protected onDisconnect(
    transport: string,
  ): TransportWorkerParams['onDisconnect'] {
    const logger = forkLogger(this.logger, undefined, undefined, { transport })
    return async (connectionId) => {
      logger.debug({ connectionId }, 'Disconnecting connection')
      this.stopHeartbeat(connectionId, 'disconnect')
      await this.closeConnection(connectionId)
    }
  }

  protected onMessage(transport: string): TransportWorkerParams['onMessage'] {
    const _logger = forkLogger(this.logger, undefined, undefined, { transport })

    return async ({ connectionId, data }, ...injections) => {
      const logger = forkLogger(_logger, undefined, undefined, { connectionId })
      try {
        const connection = this.connections.get(connectionId)
        const messageContext = this.createMessageContext(connection, transport)

        const message = connection.protocol.decodeMessage(
          messageContext,
          Buffer.from(data),
        )

        logger.trace(message, 'Received message')

        switch (message.type) {
          case ClientMessageType.Ping: {
            if (connection.type === ConnectionType.Bidirectional) {
              messageContext.transport.send!(
                connectionId,
                connection.protocol.encodeMessage(
                  messageContext,
                  ServerMessageType.Pong,
                  { nonce: message.nonce },
                ),
              )
            }
            break
          }
          case ClientMessageType.Pong: {
            const hb = this.heartbeat.get(connectionId)
            const pending = hb?.pending.get(message.nonce)
            if (pending) {
              hb!.pending.delete(message.nonce)
              pending.resolve()
            }
            break
          }
          case ClientMessageType.Rpc: {
            const rpcContext = this.createRpcContext(
              connection,
              messageContext,
              logger,
              message.rpc,
            )
            try {
              rpcContext.container.provide([
                ...injections,
                provision(
                  injectables.createBlob,
                  this.createBlobFunction(rpcContext),
                ),
                provision(
                  injectables.consumeBlob,
                  this.consumeBlobFunction(rpcContext),
                ),
              ])
              await this.handleRpcMessage(connection, rpcContext)
            } finally {
              await rpcContext[Symbol.asyncDispose]()
            }
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
    const _logger = forkLogger(this.logger, undefined, undefined, { transport })

    return async (connection, rpc, signal, ...injections) => {
      const logger = forkLogger(_logger, undefined, undefined, {
        connectionId: connection.id,
      })
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
        const result = await this.dispatchRpc(
          connection,
          rpcContext,
          injections,
        )

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

  protected resolve(
    transport: string,
  ): TransportWorkerParams<ConnectionType, ResolvedProcedure>['resolve'] {
    const _logger = forkLogger(this.logger, undefined, undefined, { transport })

    return async (connection, procedure) => {
      _logger.trace({ connectionId: connection.id, procedure }, 'Resolving RPC')

      return this.options.api.resolve({ connection, procedure })
    }
  }

  /**
   * Shared RPC dispatch prologue for both the HTTP (onRpc) and WS
   * (handleRpcMessage) paths: provisions the per-call abort signal and invokes
   * the API. rpcClientAbortSignal is the base per-call signal; rpcAbortSignal is
   * a derived injectable that combines it with connectionAbortSignal and the
   * optional rpcStreamAbortSignal.
   *
   * When `httpInjections` is provided (HTTP path), the transport-supplied
   * injections and the createBlob/consumeBlob injectables are provisioned here.
   * The WS path passes `undefined` because onMessage already provisioned those
   * before calling handleRpcMessage. This divergence — WS omits blob injectables
   * at this dispatch point — is suspected to be a gap but is intentionally
   * preserved pending a decision.
   */
  private dispatchRpc(
    connection: GatewayConnection,
    context: GatewayRpcContext,
    httpInjections?: readonly Provision[],
  ): Promise<unknown> {
    if (httpInjections) {
      context.container.provide([
        ...httpInjections,
        provision(injectables.rpcClientAbortSignal, context.signal),
        provision(injectables.createBlob, this.createBlobFunction(context)),
        provision(injectables.consumeBlob, this.consumeBlobFunction(context)),
      ])
    } else {
      context.container.provide(
        injectables.rpcClientAbortSignal,
        context.signal,
      )
    }

    return this.options.api.call({
      connection,
      container: context.container,
      payload: context.payload,
      procedure: context.procedure,
      signal: context.signal,
    })
  }

  protected async handleRpcMessage(
    connection: GatewayConnection,
    context: GatewayRpcContext,
  ): Promise<void> {
    const { connectionId, transport, protocol, signal, callId, encoder } =
      context
    try {
      const response = await this.dispatchRpc(connection, context)

      if (typeof response === 'function') {
        transport.send!(
          connectionId,
          protocol.encodeMessage(context, ServerMessageType.RpcStreamResponse, {
            callId,
          }),
        )

        try {
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

  protected closeConnection(
    connectionId: string,
    close: { code: number; reason: string } = { code: 1001, reason: 'closed' },
  ): Promise<void> {
    // Single-flight: the first caller claims the connection by removing it
    // from the map before any await; concurrent callers (e.g. heartbeat
    // timeout racing transport disconnect) await the same in-flight teardown
    // instead of tearing down twice.
    const inFlight = this.closingConnections.get(connectionId)
    if (inFlight) return inFlight
    if (!this.connections.has(connectionId)) return Promise.resolve()

    const connection = this.connections.get(connectionId)
    this.connections.remove(connectionId)

    const teardown = this.teardownConnection(connection, close).finally(() => {
      this.closingConnections.delete(connectionId)
    })
    this.closingConnections.set(connectionId, teardown)
    return teardown
  }

  private async teardownConnection(
    connection: GatewayConnection,
    close: { code: number; reason: string },
  ) {
    const connectionId = connection.id

    // Guard and time-bound each teardown step so one failure or a
    // never-settling promise can't skip or hang the rest.
    const guard = async (step: () => unknown) => {
      try {
        await withTimeout(
          Promise.resolve(step()),
          GATEWAY_TEARDOWN_STEP_TIMEOUT,
          new Error('Connection teardown step timed out'),
        )
      } catch (error) {
        this.logger.error(
          { error, connectionId },
          'Error during connection teardown',
        )
      }
    }

    await guard(() => this.stopHeartbeat(connectionId, 'close'))
    if (connection.type === ConnectionType.Bidirectional) {
      const transportWorker =
        this.options.transports[connection.transport]?.transport
      await guard(() => transportWorker?.close?.(connectionId, close))
    }
    await guard(() => connection.abortController.abort())
    await guard(() => this.rpcs.close(connectionId))
    await guard(() => this.blobStreams.cleanupConnection(connectionId))
    await guard(() => connection.container.dispose())
  }

  protected createBlobFunction(
    context: GatewayRpcContext,
  ): ResolveInjectableType<typeof injectables.createBlob> {
    const {
      streamId: getStreamId,
      transport,
      protocol,
      connectionId,
      connectionType,
      callId,
      encoder,
    } = context

    return (source, metadata) => {
      if (connectionType === ConnectionType.Unidirectional) {
        return ProtocolBlob.from(source, metadata)
      }

      const streamId = getStreamId()
      const blob = ProtocolBlob.from(source, metadata, (metadata) => {
        return encoder.encodeBlob(streamId, metadata)
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

  protected consumeBlobFunction(
    context: GatewayRpcContext,
  ): ResolveInjectableType<typeof injectables.consumeBlob> {
    const { connectionId, callId } = context

    return (blob: ProtocolBlobInterface) => {
      const streamId = getProtocolBlobStreamId(blob)
      this.blobStreams.consumeClientStream(connectionId, callId, streamId)
      return this.blobStreams.getClientStream(connectionId, streamId)
    }
  }
}

const gatewayLoggerOptions: ChildLoggerOptions = {
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
