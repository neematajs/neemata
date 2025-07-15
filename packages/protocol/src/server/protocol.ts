import { type Callback, defer, isAbortError, throwError } from '@nmtjs/common'
import {
  type AnyInjectable,
  type Container,
  Hook,
  type Logger,
  Scope,
} from '@nmtjs/core'
import { concat, decodeNumber, encodeNumber } from '../common/binary.ts'
import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'
import { ErrorCode, ServerMessageType } from '../common/enums.ts'
import type { ProtocolRPC } from '../common/types.ts'
import {
  isIterableResult,
  type ProtocolApi,
  type ProtocolApiCallOptions,
} from './api.ts'
import {
  Connection,
  ConnectionContext,
  type ConnectionOptions,
} from './connection.ts'
import type { Format } from './format.ts'
import { ProtocolInjectables } from './injectables.ts'
import type { ProtocolRegistry } from './registry.ts'
import { ProtocolClientStream, ProtocolServerStream } from './stream.ts'
import type { Transport } from './transport.ts'
import { getFormat, type ResolveFormatParams } from './utils.ts'

export class ProtocolError extends Error {
  code: string
  data?: any

  constructor(code: string, message?: string, data?: any) {
    super(message)
    this.code = code
    this.data = data
  }

  get message() {
    return `${this.code} ${super.message}`
  }

  toString() {
    return `${this.code} ${this.message}`
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    }
  }
}

export type ProtocolConnectionTransport = {
  send: Transport<any>['send']
}

export class ProtocolConnections {
  readonly #collection = new Map<
    string,
    {
      connection: Connection
      context: ConnectionContext
      transport: ProtocolConnectionTransport
    }
  >()

  constructor(
    private readonly application: {
      logger: Logger
      registry: ProtocolRegistry
      format: Format
      container: Container
    },
  ) {}

  get(connectionId: string) {
    const connection = this.#collection.get(connectionId)
    if (!connection) throwError('Connection not found')
    return connection
  }

  async add<T>(
    transport: ProtocolConnectionTransport,
    options: ConnectionOptions<T>,
    params: ResolveFormatParams,
  ) {
    const connection = new Connection(options)
    const format = getFormat(this.application.format, params)
    const container = this.application.container.fork(Scope.Connection)
    const context = new ConnectionContext(container, format)
    container.provide(ProtocolInjectables.connection, connection)
    try {
      await this.initialize(connection)
      this.#collection.set(connection.id, { connection, context, transport })
      return { connection, context }
    } catch (error) {
      container.dispose().catch((error) => {
        this.application.logger.error(
          { error, connection },
          'Error during disposing connection',
        )
      })
      throw error
    }
  }

  async remove(connectionId: string) {
    const { connection, context } = this.get(connectionId)

    this.application.registry.hooks.call(
      Hook.OnDisconnect,
      { concurrent: true },
      connection,
    )

    this.#collection.delete(connectionId)

    const { rpcs, serverStreams, clientStreams, rpcStreams, container } =
      context

    for (const call of rpcs.values()) {
      call.abort(new Error('Connection closed'))
    }

    for (const stream of clientStreams.values()) {
      stream.destroy(new Error('Connection closed'))
    }

    for (const stream of serverStreams.values()) {
      stream.destroy(new Error('Connection closed'))
    }

    for (const stream of rpcStreams.values()) {
      stream.abort(new Error('Connection closed'))
    }

    try {
      await container.dispose()
    } catch (error) {
      this.application.logger.error(
        { error, connection },
        'Error during closing connection',
      )
    }
  }

  async initialize(connection: Connection) {
    await this.application.registry.hooks.call(
      Hook.OnConnect,
      { concurrent: false },
      connection,
    )
  }
}

export class ProtocolClientStreams {
  constructor(private readonly connections: ProtocolConnections) {}

  get(connectionId: string, streamId: number) {
    const { context } = this.connections.get(connectionId)
    const { clientStreams } = context
    const stream = clientStreams.get(streamId) ?? throwError('Stream not found')
    return stream
  }

  remove(connectionId: string, streamId: number) {
    const { context } = this.connections.get(connectionId)
    const { clientStreams } = context
    clientStreams.get(streamId) || throwError('Stream not found')
    clientStreams.delete(streamId)
  }

  add(
    connectionId: string,
    streamId: number,
    metadata: ProtocolBlobMetadata,
    read: Callback,
  ) {
    const { context } = this.connections.get(connectionId)
    const { clientStreams } = context
    const stream = new ProtocolClientStream(streamId, metadata, { read })
    clientStreams.set(streamId, stream)
    return stream
  }

  push(connectionId: string, streamId: number, chunk: ArrayBuffer) {
    const stream = this.get(connectionId, streamId)
    stream.write(Buffer.from(chunk))
  }

  end(connectionId: string, streamId: number) {
    const stream = this.get(connectionId, streamId)
    stream.end(null)
    this.remove(connectionId, streamId)
  }

  abort(connectionId: string, streamId: number, error = new Error('Aborted')) {
    const stream = this.get(connectionId, streamId)
    stream.destroy(error)
    this.remove(connectionId, streamId)
  }
}

export class ProtocolServerStreams {
  constructor(private readonly connections: ProtocolConnections) {}

  get(connectionId: string, streamId: number) {
    const { context } = this.connections.get(connectionId)
    const { serverStreams } = context
    const stream = serverStreams.get(streamId) ?? throwError('Stream not found')
    return stream
  }

  add(connectionId: string, streamId: number, blob: ProtocolBlob) {
    const { context } = this.connections.get(connectionId)
    const { serverStreams } = context
    const stream = new ProtocolServerStream(streamId, blob)
    serverStreams.set(streamId, stream)
    return stream
  }

  remove(connectionId: string, streamId: number) {
    const { context } = this.connections.get(connectionId)
    const { serverStreams } = context
    serverStreams.has(streamId) || throwError('Stream not found')
    serverStreams.delete(streamId)
  }

  pull(connectionId: string, streamId: number) {
    const stream = this.get(connectionId, streamId)
    stream.resume()
  }

  abort(connectionId: string, streamId: number, error = new Error('Aborted')) {
    const stream = this.get(connectionId, streamId)
    stream.destroy(error)
    this.remove(connectionId, streamId)
  }
}

export type ProtocolRPCOptions = {
  signal?: AbortSignal
  provides?: [AnyInjectable, any][]
  metadata?: ProtocolApiCallOptions['metadata']
}

export class Protocol {
  #connections: ProtocolConnections
  #clientStreams: ProtocolClientStreams
  #serverStreams: ProtocolServerStreams

  constructor(
    protected readonly application: {
      logger: Logger
      format: Format
      container: Container
      registry: ProtocolRegistry
      api: ProtocolApi
    },
  ) {
    this.#connections = new ProtocolConnections(this.application)
    this.#clientStreams = new ProtocolClientStreams(this.#connections)
    this.#serverStreams = new ProtocolServerStreams(this.#connections)
  }

  async call(options: ProtocolApiCallOptions) {
    const { container, connection } = options
    try {
      return await this.application.api.call(options)
    } catch (error) {
      if (error instanceof ProtocolError === false) {
        this.application.logger.error(
          { error, connection },
          'Error during RPC call',
        )
        throw new ProtocolError(
          ErrorCode.InternalServerError,
          'Internal server error',
        )
      }
      throw error
    } finally {
      container.dispose().catch((error) => {
        this.application.logger.error(
          { error, connection },
          "Error during disposing connection's container",
        )
      })
    }
  }

  async rpc(
    connectionId: string,
    rpc: ProtocolRPC,
    params: ProtocolRPCOptions = {},
  ) {
    const { connection, context, transport } =
      this.#connections.get(connectionId)
    const { rpcs, format } = context
    const { callId, namespace, procedure, payload } = rpc
    const abortController = new AbortController()
    const signal = params.signal
      ? AbortSignal.any([params.signal, abortController.signal])
      : abortController.signal

    rpcs.set(callId, abortController)

    const callIdEncoded = encodeNumber(callId, 'Uint32')
    const container = context.container.fork(Scope.Call)

    if (params.provides) {
      for (const [key, value] of params.provides) {
        container.provide(key, value)
      }
    }

    try {
      const response = await this.call({
        connection,
        container,
        namespace,
        payload,
        procedure,
        signal,
        metadata: params.metadata,
      })

      const responseEncoded = format.encoder.encodeRPC(
        {
          callId,
          result: response.output,
        },
        {
          addStream: (blob) => {
            const streamId = context.streamId++
            const stream = this.#serverStreams.add(connectionId, streamId, blob)
            stream.on('data', (chunk) => {
              stream.pause()
              const buf = Buffer.from(chunk)
              transport.send(
                connection,
                ServerMessageType.ServerStreamPush,
                concat(
                  encodeNumber(streamId, 'Uint32'),
                  (buf.buffer as ArrayBuffer).slice(
                    buf.byteOffset,
                    buf.byteOffset + buf.byteLength,
                  ),
                ),
                { callId, streamId },
              )
            })
            stream.on('error', (err) => {
              transport.send(
                connection,
                ServerMessageType.ServerStreamAbort,
                encodeNumber(streamId, 'Uint32'),
                { callId, streamId },
              )
            })
            stream.on('end', () => {
              transport.send(
                connection,
                ServerMessageType.ServerStreamEnd,
                encodeNumber(streamId, 'Uint32'),
                { callId, streamId },
              )
            })
            return stream
          },
          getStream: (id) => {
            return this.#serverStreams.get(connectionId, id)
          },
        },
      )

      if (isIterableResult(response)) {
        transport.send(
          connection,
          ServerMessageType.RpcStreamResponse,
          responseEncoded,
          { callId },
        )
        try {
          const controller = new AbortController()
          context.rpcStreams.set(callId, controller)
          const iterable =
            typeof response.iterable === 'function'
              ? response.iterable(controller.signal)
              : response.iterable
          try {
            for await (const chunk of iterable) {
              controller.signal.throwIfAborted()
              const chunkEncoded = format.encoder.encode(chunk)
              transport.send(
                connection,
                ServerMessageType.RpcStreamChunk,
                concat(callIdEncoded, chunkEncoded),
                { callId },
              )
            }
            transport.send(
              connection,
              ServerMessageType.RpcStreamEnd,
              callIdEncoded,
              { callId },
            )
          } catch (error) {
            // do not re-throw AbortError errors, they are expected
            if (!isAbortError(error)) {
              throw error
            }
          }
        } catch (error) {
          this.application.logger.error(error)
          transport.send(
            connection,
            ServerMessageType.RpcStreamAbort,
            callIdEncoded,
            { callId },
          )
        } finally {
          context.rpcStreams.delete(callId)
          response.onFinish && defer(response.onFinish)
        }
      } else {
        transport.send(
          connection,
          ServerMessageType.RpcResponse,
          responseEncoded,
          { callId },
        )
      }
    } catch (error) {
      const payload = format.encoder.encodeRPC(
        { callId, error },
        {
          addStream(blob) {
            throwError('Cannot handle stream for error response')
          },
          getStream(id) {
            throwError('Cannot handle stream for error response')
          },
        },
      )

      transport.send(connection, ServerMessageType.RpcResponse, payload, {
        error,
        callId,
      })
    } finally {
      rpcs.delete(callId)
      container.dispose().catch((error) => {
        this.application.logger.error(
          { error, connection },
          'Error during disposing connection',
        )
      })
    }
  }

  async rpcRaw(
    connectionId: string,
    buffer: ArrayBuffer,
    params: ProtocolRPCOptions = {},
  ) {
    const { connection, context, transport } =
      this.#connections.get(connectionId)

    const { format } = context

    const rpc = format.decoder.decodeRPC(buffer, {
      addStream: (streamId, callId, metadata) => {
        return this.#clientStreams.add(
          connectionId,
          streamId,
          metadata,
          (size) => {
            transport.send(
              connection,
              ServerMessageType.ClientStreamPull,
              concat(
                encodeNumber(streamId, 'Uint32'),
                encodeNumber(size, 'Uint32'),
              ),
              { callId, streamId },
            )
          },
        )
      },
      getStream: (id) => {
        return this.#clientStreams.get(connectionId, id)
      },
    })

    return await this.rpc(connectionId, rpc, params)
  }

  rpcAbort(connectionId: string, callId: number) {
    const { context } = this.#connections.get(connectionId)
    const call = context.rpcs.get(callId) ?? throwError('Call not found')
    call.abort()
  }

  rpcAbortRaw(connectionId: string, buffer: ArrayBuffer) {
    const callId = decodeNumber(buffer, 'Uint32')
    return this.rpcAbort(connectionId, callId)
  }

  rpcStreamAbort(connectionId: string, callId: number) {
    const { context } = this.#connections.get(connectionId)
    const ab =
      context.rpcStreams.get(callId) ?? throwError('Call stream not found')
    ab.abort()
  }

  rpcStreamAbortRaw(connectionId: string, buffer: ArrayBuffer) {
    const callId = decodeNumber(buffer, 'Uint32')
    return this.rpcStreamAbort(connectionId, callId)
  }

  notify(connectionId: string, event, payload) {
    throw Error('Unimplemented')
  }

  addConnection(
    transport: ProtocolConnectionTransport,
    options: ConnectionOptions,
    params: ResolveFormatParams,
  ) {
    return this.#connections.add(transport, options, params)
  }

  removeConnection(connectionId: string) {
    return this.#connections.remove(connectionId)
  }

  getConnection(connectionId: string) {
    return this.#connections.get(connectionId)
  }

  initializeConnection(connection: Connection) {
    return this.#connections.initialize(connection)
  }

  getClientStream(
    connectionId: string,
    streamId: number,
  ): ProtocolClientStream {
    return this.#clientStreams.get(connectionId, streamId)
  }

  addClientStream(
    connectionId: string,
    streamId: number,
    metadata: ProtocolBlobMetadata,
    read: Callback,
  ) {
    return this.#clientStreams.add(connectionId, streamId, metadata, read)
  }

  removeClientStream(connectionId: string, streamId: number) {
    return this.#clientStreams.remove(connectionId, streamId)
  }

  pushClientStream(connectionId: string, streamId: number, chunk: ArrayBuffer) {
    return this.#clientStreams.push(connectionId, streamId, chunk)
  }

  endClientStream(connectionId: string, streamId: number) {
    return this.#clientStreams.end(connectionId, streamId)
  }

  abortClientStream(connectionId: string, streamId: number, error?: Error) {
    return this.#clientStreams.abort(connectionId, streamId, error)
  }

  getServerStream(connectionId: string, streamId: number) {
    return this.#serverStreams.get(connectionId, streamId)
  }

  addServerStream(connectionId: string, streamId: number, blob: ProtocolBlob) {
    return this.#serverStreams.add(connectionId, streamId, blob)
  }

  removeServerStream(connectionId: string, streamId: number) {
    return this.#serverStreams.remove(connectionId, streamId)
  }

  pullServerStream(connectionId: string, streamId: number) {
    return this.#serverStreams.pull(connectionId, streamId)
  }

  abortServerStream(connectionId: string, streamId: number, error?: Error) {
    return this.#serverStreams.abort(connectionId, streamId, error)
  }
}
