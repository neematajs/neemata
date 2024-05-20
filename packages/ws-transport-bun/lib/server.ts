import {
  type AnyProcedure,
  type Container,
  EncodedStreamResponse,
  Scope,
  Stream,
  StreamResponse,
  Subscription,
} from '@neematajs/application'
import { Server } from '@neematajs/bun-http-server'
import {
  AbortStreamError,
  ApiError,
  MessageType,
  StreamDataType,
  type StreamMetadata,
  decodeNumber,
  encodeNumber,
} from '@neematajs/common'
import { WsConnection } from './connection'
import type { WsTransport } from './transport'
import type { WsTransportSocket, WsUserData } from './types'
import { InternalError, getFormat, send, sendPayload } from './utils'

export class WsTransportServer {
  protected server!: Server<WsUserData>

  constructor(protected readonly transport: WsTransport) {
    this.server = new Server<WsUserData>(
      {
        port: this.options.port,
        hostname: this.options.hostname,
        tls: this.options.tls,
        development: false,
      },
      {
        cors: this.options.cors ?? {
          origin: '*',
          methods: ['GET', 'POST', 'OPTIONS'],
          headers: ['Content-Type', 'Authorization'],
          credentials: 'true',
        },
      },
    )
      .get('/healthy', () => new Response('OK'))
      .upgrade('/api', (req, server) => {
        const container = this.transport.application.container.createScope(
          Scope.Connection,
        )
        const data: WsUserData = {
          id: crypto.randomUUID(),
          format: getFormat(req, this.transport.application.format),
          container,
          streams: {
            streamId: 0,
            up: new Map(),
            down: new Map(),
          },
          subscriptions: new Map(),
          transportData: {
            transport: 'websockets' as const,
            headers: Object.fromEntries(req.headers),
            query: new URLSearchParams(req.url.split('?')[1] || ''),
            ip: server.requestIP(req),
          },
          backpressure: null,
        }
        return { data }
      })
      .ws({
        open: (ws) => {
          ws.binaryType = 'arraybuffer'
          const connection = new WsConnection(
            this.application.registry,
            ws.data.transportData,
            ws,
            ws.data.id,
            ws.data.subscriptions,
          )
          this.application.connections.add(connection)
        },
        message: (ws, event) => {
          const buffer = event as unknown as ArrayBuffer
          const messageType = decodeNumber(buffer, 'Uint8')
          if (messageType in this === false) {
            ws.close(1011, 'Unknown message type')
          } else {
            this[messageType](ws, buffer.slice(Uint8Array.BYTES_PER_ELEMENT))
          }
        },
        drain: (ws) => {
          ws.data.backpressure = null
          for (const stream of ws.data.streams.down.values()) {
            if (stream.isPaused()) stream.resume()
          }
        },
        close: (ws) => {
          this.application.connections.remove(ws.data.id)
          for (const _streams of [ws.data.streams.up, ws.data.streams.down]) {
            for (const stream of _streams.values()) stream.destroy()
            _streams.clear()
          }
          for (const subscription of ws.data.subscriptions.values()) {
            subscription.unsubscribe()
          }
          this.handleContainerDisposal(ws.data.container)
        },
      })
  }

  get options() {
    return this.transport.options
  }

  get application() {
    return this.transport.application
  }

  get api() {
    return this.transport.application.api
  }

  get logger() {
    return this.transport.application.logger
  }

  async start() {
    const url = this.server.listen()
    this.logger.info('Server started on %s', url)
  }

  async stop() {
    this.server.close()
  }

  protected async logError(
    cause: Error,
    message = 'Unknown error while processing request',
  ) {
    this.logger.error(new Error(message, { cause }))
  }

  protected handleContainerDisposal(container: Container) {
    container.dispose()
  }

  protected async handleRPC(options: {
    container: Container
    procedure: AnyProcedure
    payload: any
    connection: WsConnection
  }) {
    return await this.api.call({
      ...options,
      transport: this.transport,
    })
  }

  protected async [MessageType.Rpc](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const connection = <WsConnection>(
      this.application.connections.get(ws.data.id)
    )
    if (!connection) return void ws.close(1011, 'Unknown connection')

    const addStream = (id: number, metadata: StreamMetadata) => {
      const read = (size) => {
        const buffers = [encodeNumber(id, 'Uint32')]
        if (size) buffers.push(encodeNumber(size, 'Uint32'))
        send(ws, MessageType.ClientStreamPull, ...buffers)
      }
      const stream = new Stream(
        id,
        metadata,
        read,
        this.transport.options.maxStreamChunkLength,
      )
      ws.data.streams.up.set(id, stream)
      stream.on('error', (cause) =>
        this.logger.trace(new Error('Stream error', { cause })),
      )
    }

    const getStream = (id: number) => ws.data.streams.up.get(id)!

    const data = ws.data.format.decoder.decodeRpc(buffer, {
      addStream,
      getStream,
    })

    const container = ws.data.container.createScope(Scope.Call)

    try {
      const procedure = this.api.find(data.name, this.transport)
      const response = await this.handleRPC({
        connection,
        procedure,
        container,
        payload: data.payload,
      })

      if (response instanceof StreamResponse) {
        const streamDataType =
          response instanceof EncodedStreamResponse
            ? StreamDataType.Encoded
            : StreamDataType.Binary

        const streamId = ++ws.data.streams.streamId
        sendPayload(ws, MessageType.RpcStream, [
          data.callId,
          streamDataType,
          streamId,
          response.payload,
        ])
        ws.data.streams.down.set(streamId, response)
        response.on('data', (chunk) => {
          chunk =
            streamDataType === StreamDataType.Encoded
              ? ws.data.format.encoder.encode(chunk)
              : chunk
          send(
            ws,
            MessageType.ServerStreamPush,
            encodeNumber(streamId, 'Uint32'),
            chunk,
          )
        })
        response.once('end', () => {
          send(
            ws,
            MessageType.ServerStreamEnd,
            encodeNumber(streamId, 'Uint32'),
          )
        })
        response.once('error', () => {
          send(
            ws,
            MessageType.ServerStreamAbort,
            encodeNumber(streamId, 'Uint32'),
          )
        })
      } else if (response instanceof Subscription) {
        sendPayload(ws, MessageType.RpcSubscription, [
          data.callId,
          response.key,
        ])
        response.on('data', (payload) => {
          sendPayload(ws, MessageType.ServerSubscriptionEmit, [
            response.key,
            payload,
          ])
        })
        response.once('end', () => {
          sendPayload(ws, MessageType.ServerUnsubscribe, [response.key])
        })
      } else {
        sendPayload(ws, MessageType.Rpc, [data.callId, response, null])
      }
    } catch (error) {
      if (error instanceof ApiError) {
        sendPayload(ws, MessageType.Rpc, [data.callId, null, error])
      } else {
        this.logger.error(new Error('Unexpected error', { cause: error }))
        sendPayload(ws, MessageType.Rpc, [data.callId, null, InternalError()])
      }
    } finally {
      this.handleContainerDisposal(container)
    }
  }

  async [MessageType.ClientStreamPush](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.up.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.push(Buffer.from(buffer.slice(Uint32Array.BYTES_PER_ELEMENT)))
  }

  async [MessageType.ClientStreamEnd](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.up.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.once('end', () =>
      send(ws, MessageType.ClientStreamEnd, encodeNumber(id, 'Uint32')),
    )
    stream.push(null)
    ws.data.streams.up.delete(id)
  }

  async [MessageType.ClientStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.up.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.destroy(new AbortStreamError('Aborted by client'))
  }

  async [MessageType.ServerStreamPull](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.down.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.resume()
  }

  async [MessageType.ServerStreamEnd](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.down.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    ws.data.streams.down.delete(id)
  }

  async [MessageType.ServerStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.down.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.destroy(new AbortStreamError('Aborted by client'))
  }

  async [MessageType.ClientUnsubscribe](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const [key] = ws.data.format.decoder.decode(buffer)
    const subscription = ws.data.subscriptions.get(key)
    if (!subscription) return void ws.close()
    subscription.unsubscribe()
  }
}
