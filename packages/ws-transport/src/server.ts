import { randomUUID } from 'node:crypto'
import { Duplex, Readable } from 'node:stream'
import { Scope } from '@nmtjs/core'
import {
  ClientMessageType,
  concat,
  decodeNumber,
  ErrorCode,
  encodeNumber,
  ProtocolBlob,
  type ServerMessageType,
} from '@nmtjs/protocol'
import {
  Connection,
  getFormat,
  isIterableResult,
  type ProtocolApiCallOptions,
  ProtocolClientStream,
  ProtocolError,
  ProtocolInjectables,
  type Transport,
  type TransportPluginContext,
  UnsupportedContentTypeError,
  UnsupportedFormatError,
} from '@nmtjs/protocol/server'
import { defineHooks, type Peer } from 'crossws'
import {
  AllowedHttpMethod,
  HttpCode,
  HttpCodeMap,
  HttpStatusText,
} from './http.ts'
import { WsTransportInjectables } from './injectables.ts'
import type {
  WsAdapterParams,
  WsAdapterServer,
  WsAdapterServerFactory,
  WsConnectionData,
  WsTransportCorsCustomParams,
  WsTransportCorsOptions,
  WsTransportOptions,
} from './types.ts'
import { InternalServerErrorHttpResponse } from './utils.ts'

const NEEMATA_BLOB_HEADER = 'X-Neemata-Blob'
const DEFAULT_ALLOWED_METHODS = ['post'] as ('get' | 'post')[]
const DEFAULT_CORS_PARAMS = {
  allowCredentials: 'true',
  allowMethods: ['GET', 'POST'],
  allowHeaders: ['Content-Type', 'Accept'],
  maxAge: undefined,
  requestMethod: undefined,
  exposeHeaders: [],
  requestHeaders: [],
} satisfies WsTransportCorsCustomParams
const CORS_HEADERS_MAP: Record<
  keyof WsTransportCorsCustomParams | 'origin',
  string
> = {
  origin: 'Access-Control-Allow-Origin',
  allowMethods: 'Access-Control-Allow-Methods',
  allowHeaders: 'Access-Control-Allow-Headers',
  allowCredentials: 'Access-Control-Allow-Credentials',
  maxAge: 'Access-Control-Max-Age',
  exposeHeaders: 'Access-Control-Expose-Headers',
  requestHeaders: 'Access-Control-Request-Headers',
  requestMethod: 'Access-Control-Request-Method',
}

export class WsTransportServer implements Transport<WsConnectionData> {
  #server: WsAdapterServer
  #corsOptions?:
    | null
    | true
    | string[]
    | WsTransportCorsOptions
    | ((origin: string) => boolean | WsTransportCorsOptions)

  clients = new Map<string, Peer>()

  constructor(
    protected readonly adapterFactory: WsAdapterServerFactory<any>,
    protected readonly context: TransportPluginContext,
    protected readonly options: WsTransportOptions,
  ) {
    this.#server = this.createServer()
    this.#corsOptions = this.options.cors
  }

  start() {
    return this.#server.start()
  }

  stop() {
    return this.#server.stop()
  }

  send(
    connection: Connection<WsConnectionData>,
    messageType: ServerMessageType,
    buffer: ArrayBuffer,
  ) {
    const peer = this.clients.get(connection.id)
    peer?.send(concat(encodeNumber(messageType, 'Uint8'), buffer))
  }

  async httpHandler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/').filter(Boolean)

    // Expect /api/{namespace}/{procedure}
    if (pathParts.length < 3 || pathParts[0] !== 'api') {
      return new Response('Not Found', {
        status: HttpCode.NotFound,
        statusText: HttpStatusText[HttpCode.NotFound],
      })
    }

    const namespace = pathParts[1]
    const procedure = pathParts[2]
    const method = request.method.toLowerCase()

    const origin = request.headers.get('origin')
    const responseHeaders = new Headers()
    if (origin) this.applyCors(origin, request, responseHeaders)

    // Handle preflight requests
    if (method === 'options') {
      return new Response(null, {
        status: HttpCode.OK,
        headers: responseHeaders,
      })
    }

    const controller = new AbortController()
    const isBlob = request.headers.get(NEEMATA_BLOB_HEADER) === 'true'
    const contentType = request.headers.get('content-type')
    const acceptType = request.headers.get('accept')
    const connectionId = randomUUID()

    try {
      // Create temporary connection for HTTP request
      const connection = new Connection<WsConnectionData>({
        id: connectionId,
        data: { type: 'http' },
      })

      const container = this.context.container.fork(Scope.Call)
      container.provide(ProtocolInjectables.connection, connection)
      container.provide(
        ProtocolInjectables.connectionAbortSignal,
        controller.signal,
      )

      // Set up HTTP-specific injectables
      container.provide(WsTransportInjectables.connectionData, request)
      container.provide(
        WsTransportInjectables.httpResponseHeaders,
        responseHeaders,
      )

      // Get format for encoding/decoding
      const format = getFormat(this.context.format, {
        acceptType,
        contentType: isBlob ? '*/*' : contentType,
      })

      // Parse request body if present
      let payload: any
      if (method === 'post' && request.body) {
        if (isBlob) {
          const type = contentType || 'application/octet-stream'
          const contentLength = request.headers.get('content-length')
          const size = contentLength
            ? Number.parseInt(contentLength)
            : undefined
          payload = new ProtocolClientStream(-1, { size, type })
          Readable.fromWeb(request.body as any).pipe(payload)
        } else {
          const buffer = await request.arrayBuffer()
          payload =
            buffer.byteLength > 0 ? format.decoder.decode(buffer) : undefined
        }
      }

      const metadata: ProtocolApiCallOptions['metadata'] = (metadata) => {
        const allowHttpMethod =
          metadata.get(AllowedHttpMethod) ?? DEFAULT_ALLOWED_METHODS
        if (!allowHttpMethod.includes(method as any)) {
          throw new ProtocolError(ErrorCode.NotFound)
        }
      }

      const result = await this.protocol.call({
        connection,
        namespace,
        procedure,
        payload,
        metadata,
        container,
        signal: controller.signal,
      })

      // Handle streaming results
      if (isIterableResult(result)) {
        controller.abort('Transport does not support streaming results')
        // TODO: might be better to fail early by checking procedure's contract
        // without actually calling it
        return new Response('Not Implemented', {
          status: HttpCode.NotImplemented,
          statusText: HttpStatusText[HttpCode.NotImplemented],
          headers: responseHeaders,
        })
      }

      const { output } = result

      // Handle blob responses
      if (output instanceof ProtocolBlob) {
        const { source, metadata } = output
        const { type } = metadata

        responseHeaders.set(NEEMATA_BLOB_HEADER, 'true')
        responseHeaders.set('Content-Type', type)
        if (metadata.size) {
          responseHeaders.set('Content-Length', metadata.size.toString())
        }

        // Convert source to ReadableStream
        let stream: ReadableStream

        if (source instanceof ReadableStream) {
          stream = source
        } else if (source instanceof Readable || source instanceof Duplex) {
          stream = Readable.toWeb(source) as unknown as ReadableStream
        } else {
          throw new Error('Invalid stream source')
        }

        return new Response(stream, {
          status: HttpCode.OK,
          statusText: HttpStatusText[HttpCode.OK],
          headers: responseHeaders,
        })
      }

      // Handle regular responses
      const buffer = format.encoder.encode(output)
      responseHeaders.set('Content-Type', format.encoder.contentType)

      return new Response(buffer, {
        status: HttpCode.OK,
        statusText: HttpStatusText[HttpCode.OK],
        headers: responseHeaders,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        return new Response('Request Timeout', {
          status: HttpCode.RequestTimeout,
          statusText: HttpStatusText[HttpCode.RequestTimeout],
        })
      }

      if (error instanceof UnsupportedFormatError) {
        const status =
          error instanceof UnsupportedContentTypeError
            ? HttpCode.UnsupportedMediaType
            : HttpCode.NotAcceptable
        const text = HttpStatusText[status]

        return new Response(text, {
          status,
          statusText: text,
          headers: responseHeaders,
        })
      }

      if (error instanceof ProtocolError) {
        const status =
          error.code in HttpCodeMap
            ? HttpCodeMap[error.code]
            : HttpCode.InternalServerError
        const text = HttpStatusText[status]

        const format = getFormat(this.context.format, {
          acceptType,
          contentType: isBlob ? '*/*' : contentType,
        })

        const payload = format.encoder.encode(error)
        responseHeaders.set('Content-Type', format.encoder.contentType)

        return new Response(payload, {
          status,
          statusText: text,
          headers: responseHeaders,
        })
      }

      // Unknown error
      this.logError(error, 'Unknown error while processing HTTP request')

      const format = getFormat(this.context.format, {
        acceptType,
        contentType: isBlob ? '*/*' : contentType,
      })

      const payload = format.encoder.encode(
        new ProtocolError(
          ErrorCode.InternalServerError,
          'Internal Server Error',
        ),
      )
      responseHeaders.set('Content-Type', format.encoder.contentType)

      return new Response(payload, {
        status: HttpCode.InternalServerError,
        statusText: HttpStatusText[HttpCode.InternalServerError],
        headers: responseHeaders,
      })
    }
  }

  private applyCors(origin: string, request: Request, headers: Headers) {
    if (!this.#corsOptions) return

    let params: WsTransportCorsCustomParams | null = null

    if (this.options.cors === true) {
      params = DEFAULT_CORS_PARAMS
    } else if (
      Array.isArray(this.options.cors) &&
      this.options.cors.includes(origin)
    ) {
      params = DEFAULT_CORS_PARAMS
    } else if (typeof this.options.cors === 'function') {
      const result = this.options.cors(origin, request)
      if (typeof result === 'boolean') {
        if (result) {
          params = DEFAULT_CORS_PARAMS
        }
      } else if (typeof result === 'object') {
        params = DEFAULT_CORS_PARAMS
        for (const key in result) {
          params[key] = result[key]
        }
      }
    }

    if (params === null) return

    headers.set(CORS_HEADERS_MAP.origin, origin)

    for (const key in params) {
      const header = CORS_HEADERS_MAP[key]
      if (header) {
        let value = params[key]
        if (Array.isArray(value)) value = value.filter(Boolean).join(', ')
        if (value) headers.set(header, value)
      }
    }
  }

  protected get protocol() {
    return this.context.protocol
  }

  protected get logger() {
    return this.context.logger
  }

  protected async logError(
    cause: any,
    message = 'Unknown error while processing request',
  ) {
    this.logger.error(new Error(message, { cause }))
  }

  protected [ClientMessageType.Rpc](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    this.protocol.rpcRaw(connectionId, buffer)
  }

  protected [ClientMessageType.RpcAbort](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    this.protocol.rpcAbortRaw(connectionId, buffer)
  }

  protected [ClientMessageType.RpcStreamAbort](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    this.protocol.rpcStreamAbortRaw(connectionId, buffer)
  }

  protected [ClientMessageType.ClientStreamPush](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.pushClientStream(
      connectionId,
      streamId,
      buffer.slice(Uint32Array.BYTES_PER_ELEMENT),
    )
  }

  protected [ClientMessageType.ClientStreamEnd](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.endClientStream(connectionId, streamId)
  }

  protected [ClientMessageType.ClientStreamAbort](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.abortClientStream(connectionId, streamId)
  }

  protected [ClientMessageType.ServerStreamPull](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.pullServerStream(connectionId, streamId)
  }

  protected [ClientMessageType.ServerStreamAbort](
    peer: Peer,
    buffer: ArrayBuffer,
    connectionId: string,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.abortServerStream(connectionId, streamId)
  }

  private createWsHooks() {
    return defineHooks({
      upgrade: async (request) => {
        const url = new URL(request.url)
        const contentType =
          url.searchParams.get('content-type') ||
          request.headers.get('content-type')
        const acceptType =
          url.searchParams.get('accept') || request.headers.get('accept')

        const connectionId = randomUUID()
        const controller = new AbortController()

        try {
          const { context } = await this.protocol.addConnection(
            this,
            { id: connectionId, data: { type: 'ws' } },
            { acceptType, contentType },
          )
          context.container.provide(
            WsTransportInjectables.connectionData,
            request,
          )
          context.container.provide(
            ProtocolInjectables.connectionAbortSignal,
            controller.signal,
          )
          return {
            context: {
              id: connectionId,
              contentType,
              acceptType,
              controller,
              context,
              request,
            },
          }
        } catch (error) {
          this.logger.error(
            new Error('Failed to upgrade connection', { cause: error }),
          )
          return InternalServerErrorHttpResponse()
        }
      },
      open: (peer) => {
        const { id } = peer.context
        this.logger.debug('Connection %s opened', id)
        this.clients.set(id, peer)
      },
      message: async (peer, message) => {
        const buffer = message.uint8Array().buffer as ArrayBuffer
        const messageType = decodeNumber(buffer, 'Uint8')
        if (messageType in this === false) {
          peer.close(1011, 'Unknown message type')
        } else {
          try {
            await (this as any)[messageType](
              peer,
              buffer.slice(Uint8Array.BYTES_PER_ELEMENT),
              peer.context.id,
            )
          } catch (error: any) {
            this.logError(error, 'Error while processing message')
          }
        }
      },
      error: (peer, error) => {
        this.logger.error(
          new Error(`WebSocket error ${peer.context.id}`, {
            cause: error,
          }),
        )
      },
      close: async (peer, details) => {
        const { id, controller } = peer.context
        controller.abort()
        this.logger.debug(
          'Connection %s closed with code %s: %s',
          peer.context.id,
          details.code,
          details.reason,
        )
        this.clients.delete(id)
        await this.protocol.removeConnection(id)
      },
    })
  }

  private createServer() {
    const hooks = this.createWsHooks()
    const opts: WsAdapterParams = {
      ...this.options,
      apiPath: '/api',
      wsHooks: hooks,
      fetchHandler: this.httpHandler.bind(this),
    }
    return this.adapterFactory(opts)
  }
}
