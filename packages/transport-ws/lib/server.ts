import {
  type AnyProcedure,
  type Callback,
  type Container,
  JsonStreamResponse,
  type Procedure,
  Scope,
  Stream,
  StreamResponse,
  Subscription,
} from '@neematajs-bun/application'
import {
  AbortStreamError,
  ApiError,
  ErrorCode,
  STREAM_SERIALIZE_KEY,
  StreamDataType,
  decodeNumber,
  decodeText,
  encodeNumber,
} from '@neematajs-bun/common'
import type { Serve, Server, WebSocketHandler } from 'bun'
import qs from 'qs'
import {
  HttpTransportConnection,
  WebsocketsTransportConnection,
} from './connection'
import {
  HttpTransportMethod,
  HttpTransportMethodOption,
  MessageType,
} from './constants'
import type { WsTransport } from './transport'
import type { WsTransportSocket, WsUserData } from './types'
import {
  InternalError,
  type ParsedRequest,
  fromJSON,
  getBody,
  getRequest,
  send,
  sendPayload,
  toJSON,
} from './utils'

const HTTP_SUPPORTED_METHODS = ['GET', 'POST', 'OPTIONS']

class HttpServer {
  instance!: Server

  protected serveOptions!: Serve<any>

  constructor(protected readonly transport: WsTransport) {
    this.serveOptions = {
      // @ts-expect-error
      websocket: undefined,
      port: this.options.port,
      hostname: this.options.hostname,
      tls: this.options.tls,
      development: false,
      fetch: async (req) => {
        const request = getRequest(req, this.instance)
        const headers = new Headers({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, X-Auth-Token',
          'Content-Type': 'application/json',
        })

        try {
          if (!HTTP_SUPPORTED_METHODS.includes(request.method)) {
            return new Response(null, { status: 405 })
          }

          const name = request.path
          const procedure = this.api.find(name, this.transport)
          if (request.method === 'OPTIONS') {
            return new Response(null, {
              status: 204,
              headers,
            })
          }
          const payload = await this.getPayload(request)

          return await this.handleHttpRequest({
            request,
            procedure,
            payload,
            // @ts-expect-error Bun types conflicting with Node types
            headers,
          })
        } catch (cause) {
          if (cause instanceof ApiError) {
            return new Response(toJSON(cause), { headers })
          } else {
            if (cause instanceof Error) this.logError(cause)
            const error = new ApiError(ErrorCode.InternalServerError)
            return new Response(toJSON(error), { headers })
          }
        }
      },
    }
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
    this.instance = Bun.serve<WsUserData>(this.serveOptions)
  }

  async stop() {
    await this.instance.stop()
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
    connection: HttpTransportConnection | WebsocketsTransportConnection
  }) {
    return await this.api.call({
      ...options,
      transport: this.transport,
    })
  }

  private async handleHttpRequest(options: {
    request: ParsedRequest
    procedure: Procedure
    headers: Headers
    payload: any
  }) {
    const { procedure, request, payload, headers } = options

    const allowedMethods = procedure[HttpTransportMethodOption] ?? [
      HttpTransportMethod.Post,
    ]

    if (!allowedMethods.includes(request.method)) {
      throw new ApiError(ErrorCode.NotFound)
    }

    const connection = new HttpTransportConnection(
      this.application.registry,
      {
        headers: Object.fromEntries(request.req.headers),
        query: request.query,
        method: request.method as HttpTransportMethod,
        ip: request.ip,
        transport: 'http',
      },
      headers,
    )
    const container = this.application.container.createScope(Scope.Call)
    try {
      const result = await this.handleRPC({
        container,
        procedure,
        payload,
        connection,
      })
      if (result instanceof Blob) {
        if (request.method !== 'GET') {
          this.logger.error('Blob is only supported for GET requests')
          throw new ApiError(ErrorCode.InternalServerError)
        }
        this.handleContainerDisposal(container)
        return new Response(result, {
          status: 200,
          headers,
        })
      } else if (result instanceof StreamResponse) {
        if (request.method === 'GET' && result instanceof JsonStreamResponse) {
          this.logger.error('Json stream is only supported for POST requests')
          throw new ApiError(ErrorCode.InternalServerError)
        }
        result.once('end', () => this.handleContainerDisposal(container))
        return new Response(result, { status: 200, headers })
      } else {
        this.handleContainerDisposal(container)
        return new Response(toJSON(result), { status: 200, headers })
      }
    } catch (error) {
      this.handleContainerDisposal(container)
    }
  }

  private async getPayload(request: ParsedRequest) {
    if (request.method === 'GET') {
      return qs.parse(request.queryString)
    } else {
      return await getBody(request.req).toJSON()
    }
  }
}

export class WsServer extends HttpServer {
  constructor(protected readonly transport: WsTransport) {
    super(transport)
    const httpServe = this.serveOptions.fetch

    this.serveOptions = {
      ...this.serveOptions,
      fetch: (req, res) => {
        if (req.url === '/' && req.headers.get('upgrade') === 'websocket') {
          const container = this.transport.application.container.createScope(
            Scope.Connection,
          )
          const data: WsUserData = {
            id: crypto.randomUUID(),
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
            },
            backpressure: null,
          }
          if (this.instance.upgrade<WsUserData>(req, { data }))
            return undefined as unknown as any
          else return new Response('Upgrade failed', { status: 500 })
        } else {
          return httpServe.call(this.instance, req, res)
        }
      },
      websocket: <WebSocketHandler<WsUserData>>{
        open: (ws) => {
          ws.binaryType = 'arraybuffer'
          const connection = new WebsocketsTransportConnection(
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
      },
    }
  }

  protected async [MessageType.Rpc](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const connection = <WebsocketsTransportConnection>(
      this.application.connections.get(ws.data.id)
    )
    if (!connection) return void ws.close(1011, 'Unknown connection')
    const streams = this.handleRPCStreams(ws, buffer)
    const data = this.handleRPCMessageData(
      buffer.slice(Uint32Array.BYTES_PER_ELEMENT + streams.length),
      streams.replacer,
    )
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
          response instanceof JsonStreamResponse
            ? StreamDataType.Json
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
          chunk = streamDataType === StreamDataType.Json ? toJSON(chunk) : chunk
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
    const [key] = fromJSON(decodeText(buffer))
    const subscription = ws.data.subscriptions.get(key)
    if (!subscription) return void ws.close()
    subscription.unsubscribe()
  }

  protected handleRPCStreams(ws: WsTransportSocket, buffer: ArrayBuffer) {
    const length = decodeNumber(buffer, 'Uint32')
    const streams = fromJSON(
      decodeText(
        buffer.slice(
          Uint32Array.BYTES_PER_ELEMENT,
          Uint32Array.BYTES_PER_ELEMENT + length,
        ),
      ),
    )

    const replacer = streams.length
      ? (key, value) => {
          const isStream =
            value &&
            typeof value === 'string' &&
            value.startsWith(STREAM_SERIALIZE_KEY)
          if (isStream) {
            const streamId = value.slice(STREAM_SERIALIZE_KEY.length)
            return ws.data.streams.up.get(Number.parseInt(streamId))
          }
          return value
        }
      : undefined

    for (const [id, metadata] of streams) {
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

    return { length, replacer }
  }

  protected handleRPCMessageData(
    buffer: ArrayBuffer,
    streamsJsonReplacer?: Callback,
  ) {
    const payloadText = decodeText(buffer)
    const payloadParsed = fromJSON(payloadText, streamsJsonReplacer)
    const [callId, name, payload] = payloadParsed
    return { callId, name, payload }
  }
}
