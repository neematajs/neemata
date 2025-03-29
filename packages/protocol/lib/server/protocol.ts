import { type Callback, createPromise, defer, throwError } from '@nmtjs/common'
import { type Container, Hook, type Logger, Scope } from '@nmtjs/core'
import { concat, decodeNumber, encodeNumber } from '../common/binary.ts'
import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'
import { ErrorCode, ServerMessageType } from '../common/enums.ts'
import type { ProtocolRPC } from '../common/types.ts'
import type { ProtocolApi, ProtocolApiCallResult } from './api.ts'
import {
  Connection,
  ConnectionContext,
  type ConnectionOptions,
} from './connection.ts'
import type { Format } from './format.ts'
import type { ProtocolRegistry } from './registry.ts'
import { ProtocolClientStream, ProtocolServerStream } from './stream.ts'
import type { Transport } from './transport.ts'
import { type ResolveFormatParams, getFormat } from './utils.ts'

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

export class ProtocolConnections {
  readonly #collection = new Map<
    string,
    {
      connection: Connection
      context: ConnectionContext
      transport: Transport
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
    transport: Transport<any>,
    options: ConnectionOptions<T>,
    params: ResolveFormatParams,
  ) {
    const connection = new Connection(options)
    const format = getFormat(this.application.format, params)
    const container = this.application.container.fork(Scope.Connection)
    const context = new ConnectionContext(container, format)

    this.#collection.set(connection.id, { connection, context, transport })

    await this.application.registry.hooks.call(
      Hook.OnConnect,
      { concurrent: false },
      connection,
    )

    return { connection, context }
  }

  async remove(connectionId: string) {
    const { connection, context } = this.get(connectionId)

    this.application.registry.hooks.call(
      Hook.OnDisconnect,
      { concurrent: true },
      connection,
    )

    this.#collection.delete(connectionId)

    const { calls, serverStreams, clientStreams, rpcStreams, container } =
      context

    for (const call of calls.values()) {
      call.reject(new Error('Connection closed'))
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
    stream.push(Buffer.from(chunk))
  }

  end(connectionId: string, streamId: number) {
    const stream = this.get(connectionId, streamId)
    stream.push(null)
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

export class Protocol {
  readonly connections: ProtocolConnections
  readonly clientStreams: ProtocolClientStreams
  readonly serverStreams: ProtocolServerStreams

  constructor(
    protected readonly application: {
      logger: Logger
      format: Format
      container: Container
      registry: ProtocolRegistry
      api: ProtocolApi
    },
  ) {
    this.connections = new ProtocolConnections(this.application)
    this.clientStreams = new ProtocolClientStreams(this.connections)
    this.serverStreams = new ProtocolServerStreams(this.connections)
  }

  async rpc(
    connectionId: string,
    rpc: ProtocolRPC,
    params: { signal?: AbortSignal } = {},
  ) {
    const { connection, context, transport } =
      this.connections.get(connectionId)
    const { calls, format } = context
    const { callId, namespace, procedure, payload } = rpc
    const abortController = new AbortController()
    const signal = params.signal
      ? AbortSignal.any([params.signal, abortController.signal])
      : abortController.signal

    const call = Object.assign(createPromise<ProtocolApiCallResult>(), {
      abort: () => abortController.abort(),
    })

    calls.set(callId, call)
    call.promise.finally(() => calls.delete(callId))

    const callIdEncoded = encodeNumber(callId, 'Uint32')
    const container = context.container.fork(Scope.Call)

    try {
      const response = await this.application.api.call({
        connection,
        container,
        namespace,
        payload,
        procedure,
        signal,
      })

      const responseEncoded = format.encoder.encodeRPC(
        {
          callId,
          payload: response.output,
        },
        {
          addStream: (blob) => {
            const id = context.streamId++
            const stream = this.serverStreams.add(connectionId, id, blob)
            stream.on('data', (chunk) => {
              stream.pause()
              transport.send(
                connection,
                ServerMessageType.ServerStreamPush,
                concat(
                  encodeNumber(id, 'Uint32'),
                  Buffer.from(chunk).buffer as ArrayBuffer,
                ),
              )
            })
            stream.on('error', (err) => {
              transport.send(
                connection,
                ServerMessageType.ServerStreamAbort,
                encodeNumber(id, 'Uint32'),
              )
            })
            stream.on('end', () => {
              transport.send(
                connection,
                ServerMessageType.ServerStreamEnd,
                encodeNumber(id, 'Uint32'),
              )
            })
            return stream
          },
          getStream: (id) => {
            return this.clientStreams.get(connectionId, id)
          },
        },
      )

      if ('subscription' in response) {
        throwError('Unimplemented')
      } else if ('iterable' in response) {
        transport.send(
          connection,
          ServerMessageType.RpcStreamResponse,
          responseEncoded,
        )
        try {
          const ab = new AbortController()
          context.rpcStreams.set(callId, ab)
          const iterable =
            typeof response.iterable === 'function'
              ? response.iterable()
              : response.iterable
          for await (const chunk of iterable) {
            if (ab.signal.aborted) break
            const chunkEncoded = format.encoder.encode(chunk)
            transport.send(
              connection,
              ServerMessageType.RpcStreamChunk,
              concat(callIdEncoded, chunkEncoded),
            )
          }
        } catch (error) {
          this.application.logger.error(error)
          transport.send(
            connection,
            ServerMessageType.RpcStreamAbort,
            callIdEncoded,
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
        )
      }
    } catch (error) {
      if (error instanceof ProtocolError === false) {
        this.application.logger.error(
          { error, connection },
          'Error during RPC call',
        )

        // biome-ignore lint/suspicious/noCatchAssign:
        error = new ProtocolError(
          ErrorCode.InternalServerError,
          'Internal server error',
        )
      }

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
      transport.send(connection, ServerMessageType.RpcResponse, payload)
    } finally {
      container.dispose().catch((error) => {
        this.application.logger.error(
          { error, connection },
          "Error during disposing connection's container",
        )
      })
    }
  }

  async rpcRaw(
    connectionId: string,
    buffer: ArrayBuffer,
    params: { signal?: AbortSignal } = {},
  ) {
    const { connection, context, transport } =
      this.connections.get(connectionId)

    const { format } = context

    const rpc = format.decoder.decodeRPC(buffer, {
      addStream: (id, metadata) => {
        return this.clientStreams.add(connectionId, id, metadata, (size) => {
          transport.send(
            connection,
            ServerMessageType.ClientStreamPull,
            concat(encodeNumber(id, 'Uint32'), encodeNumber(size, 'Uint32')),
          )
        })
      },
      getStream: (id) => {
        return this.serverStreams.get(connectionId, id)
      },
    })

    return await this.rpc(connectionId, rpc, params)
  }

  rpcAbort(connectionId: string, callId: number) {
    const { context } = this.connections.get(connectionId)
    const call = context.calls.get(callId) ?? throwError('Call not found')
    call.abort()
  }

  rpcAbortRaw(connectionId: string, buffer: ArrayBuffer) {
    const callId = decodeNumber(buffer, 'Uint32')
    return this.rpcAbort(connectionId, callId)
  }

  rpcStreamAbort(connectionId: string, callId: number) {
    const { context } = this.connections.get(connectionId)
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
}
