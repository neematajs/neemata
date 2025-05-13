import {
  App,
  type HttpRequest,
  type HttpResponse,
  SSLApp,
  type TemplatedApp,
  us_socket_local_port,
} from 'uWebSockets.js'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Duplex, Readable } from 'node:stream'
import { Scope } from '@nmtjs/core'
import {
  ClientMessageType,
  decodeNumber,
  ErrorCode,
  ProtocolBlob,
  type ServerMessageType,
} from '@nmtjs/protocol/common'
import {
  Connection,
  getFormat,
  isIterableResult,
  isSubscriptionResult,
  type ProtocolApiCallOptions,
  ProtocolClientStream,
  ProtocolError,
  ProtocolInjectables,
  type Transport,
  type TransportPluginContext,
  UnsupportedContentTypeError,
  UnsupportedFormatError,
} from '@nmtjs/protocol/server'
import {
  AllowedHttpMethod,
  HttpCode,
  HttpCodeMap,
  HttpStatusText,
} from './http.ts'
import { WsTransportInjectables } from './injectables.ts'
import type {
  WsConnectionData,
  WsTransportOptions,
  WsTransportSocket,
  WsUserData,
} from './types.ts'
import {
  getRequestBody,
  getRequestData,
  readableToArrayBuffer,
  send,
  setHeaders,
} from './utils.ts'

const DEFAULT_ALLOWED_METHODS = ['post'] as ('get' | 'post')[]

export class WsTransportServer implements Transport<WsConnectionData> {
  protected server!: TemplatedApp
  protected clients: Map<string, WsTransportSocket> = new Map()

  constructor(
    protected readonly context: TransportPluginContext,
    protected readonly options: WsTransportOptions,
  ) {
    this.server = this.options.tls ? SSLApp(options.tls!) : App()
    this.server
      .options('/*', (res, req) => {
        this.applyCors(res, req)
        res.writeStatus('200 OK')
        res.endWithoutBody()
      })
      .get('/healthy', (res, req) => {
        this.applyCors(res, req)
        res.writeHeader('Content-Type', 'text/plain')
        res.end('OK')
      })
      .ws<WsUserData>('/api', {
        sendPingsAutomatically: true,
        maxPayloadLength: this.options.maxPayloadLength,
        upgrade: async (res, req, socketContext) => {
          const ac = new AbortController()

          res.onAborted(ac.abort.bind(ac))

          const requestData = getRequestData(req, res)
          const contentType =
            requestData.query.get('content-type') ||
            requestData.headers.get('content-type')
          const acceptType =
            requestData.query.get('accept') || requestData.headers.get('accept')

          const connectionId = randomUUID()

          try {
            const { context } = await this.protocol.addConnection(
              this,
              { id: connectionId, data: { type: 'ws' } },
              { acceptType, contentType },
            )
            context.container.provide(
              WsTransportInjectables.connectionData,
              requestData,
            )
            if (!ac.signal.aborted) {
              res.cork(() => {
                res.upgrade(
                  {
                    id: connectionId,
                    request: requestData,
                    contentType,
                    acceptType,
                    backpressure: null,
                    context,
                  } as WsUserData,
                  req.getHeader('sec-websocket-key'),
                  req.getHeader('sec-websocket-protocol'),
                  req.getHeader('sec-websocket-extensions'),
                  socketContext,
                )
              })
            }
          } catch (error) {
            this.logger.debug(
              new Error('Failed to upgrade connection', { cause: error }),
            )
            if (!ac.signal.aborted) {
              res.cork(() => {
                res.writeStatus('500 Internal Server Error')
                res.endWithoutBody()
              })
            }
          }
        },
        open: (ws: WsTransportSocket) => {
          const { id } = ws.getUserData()
          this.logger.debug('Connection %s opened', id)
          this.clients.set(id, ws)
        },
        message: async (ws: WsTransportSocket, buffer) => {
          const messageType = decodeNumber(buffer, 'Uint8')
          if (messageType in this === false) {
            ws.end(1011, 'Unknown message type')
          } else {
            try {
              await this[messageType](
                ws,
                buffer.slice(Uint8Array.BYTES_PER_ELEMENT),
              )
            } catch (error: any) {
              this.logError(error, 'Error while processing message')
            }
          }
        },
        drain: (ws: WsTransportSocket) => {
          const data = ws.getUserData()
          data.backpressure?.resolve()
          data.backpressure = null
        },
        close: async (ws: WsTransportSocket, code, message) => {
          const { id } = ws.getUserData()

          this.logger.debug(
            'Connection %s closed with code %s: %s',
            id,
            code,
            Buffer.from(message).toString(),
          )
          this.clients.delete(id)
          await this.protocol.removeConnection(id)
        },
      })
      .get('/api/:namespace/:procedure', this.httpHandler.bind(this))
      .post('/api/:namespace/:procedure', this.httpHandler.bind(this))
  }

  send(
    connection: Connection<WsConnectionData>,
    messageType: ServerMessageType,
    buffer: ArrayBuffer,
  ) {
    const ws = this.clients.get(connection.id)
    if (ws) send(ws, messageType, buffer)
  }

  async start() {
    return new Promise<void>((resolve, reject) => {
      const { hostname = '127.0.0.1', port = 0, unix } = this.options
      if (unix) {
        this.server.listen_unix((socket) => {
          if (socket) {
            this.logger.info('Server started on unix://%s', unix)
            resolve()
          } else {
            reject(new Error('Failed to start WebSockets server'))
          }
        }, unix)
      } else {
        this.server.listen(hostname, port, (socket) => {
          if (socket) {
            this.logger.info(
              'WebSocket Server started on %s:%s',
              hostname,
              us_socket_local_port(socket),
            )
            resolve()
          } else {
            reject(new Error('Failed to start WebSockets server'))
          }
        })
      }
    })
  }

  async stop() {
    this.server.close()
  }

  // TODO: decompose this mess
  protected async httpHandler(res: HttpResponse, req: HttpRequest) {
    this.applyCors(res, req)

    const ac = new AbortController()

    res.onAborted(ac.abort.bind(ac))

    const method = req.getMethod() as 'get' | 'post'
    const namespace = req.getParameter('namespace')
    const procedure = req.getParameter('procedure')
    const requestData = getRequestData(req, res)

    if (!namespace || !procedure) {
      const status = HttpCode.NotFound
      const text = HttpStatusText[status]
      return void res.cork(() => {
        if (ac.signal.aborted) return
        res.writeStatus(`${status} ${text}`)
        res.endWithoutBody()
      })
    }

    const isBlob = requestData.headers.get('x-neemata-blob') === 'true'

    const contentType = requestData.headers.get('content-type')
    const acceptType = requestData.headers.get('accept')
    const connectionId = randomUUID()
    const connection = new Connection<WsConnectionData>({
      id: connectionId,
      data: { type: 'http' },
    })
    const responseHeaders = new Headers()
    const container = this.context.container.fork(Scope.Call)
    container.provide(ProtocolInjectables.connection, connection)
    container.provide(WsTransportInjectables.connectionData, requestData)
    container.provide(
      WsTransportInjectables.httpResponseHeaders,
      responseHeaders,
    )

    const body = method === 'post' ? getRequestBody(res) : undefined

    const metadata: ProtocolApiCallOptions['metadata'] = (metadata) => {
      const allowHttpMethod =
        metadata.get(AllowedHttpMethod) ?? DEFAULT_ALLOWED_METHODS
      if (!allowHttpMethod.includes(method)) {
        throw new ProtocolError(ErrorCode.NotFound)
      }
    }
    let format: ReturnType<typeof getFormat>
    try {
      format = getFormat(this.context.format, {
        acceptType,
        contentType: isBlob ? '*/*' : contentType,
      })

      let payload: any = undefined

      if (body) {
        if (isBlob) {
          const type = contentType || 'application/octet-stream'
          const contentLength = requestData.headers.get('content-length')
          const size = contentLength
            ? Number.parseInt(contentLength)
            : undefined
          const stream = new ProtocolClientStream(-1, { size, type })
          body.pipe(stream)
          payload = stream
        } else {
          const buffer = await readableToArrayBuffer(body)
          if (buffer.byteLength > 0) {
            payload = format.decoder.decode(buffer)
          }
        }
      }

      const result = await this.protocol.call({
        connection,
        namespace,
        procedure,
        payload,
        metadata,
        container,
        signal: ac.signal,
      })

      if (isIterableResult(result) || isSubscriptionResult(result)) {
        res.cork(() => {
          if (ac.signal.aborted) return
          const status = HttpCode.NotImplemented
          const text = HttpStatusText[status]
          res.writeStatus(`${status} ${text}`)
          res.end()
        })
      } else {
        const { output } = result

        if (output instanceof ProtocolBlob) {
          const { source, metadata } = output
          const { type } = metadata

          let stream: Readable

          if (source instanceof ReadableStream) {
            stream = Readable.fromWeb(source as any)
          } else if (source instanceof Readable || source instanceof Duplex) {
            stream = Readable.from(source)
          } else {
            throw new Error('Invalid stream source')
          }

          res.cork(() => {
            if (ac.signal.aborted) return
            responseHeaders.set('X-Neemata-Blob', 'true')
            responseHeaders.set('Content-Type', type)
            if (metadata.size)
              res.writeHeader('Content-Length', metadata.size.toString())
            setHeaders(res, responseHeaders)
          })

          ac.signal.addEventListener('abort', () => stream.destroy(), {
            once: true,
          })

          stream.on('data', (chunk) => {
            console.log({ chunk })
            if (ac.signal.aborted) return
            const buf = Buffer.from(chunk)
            const ab = buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength,
            )
            const ok = res.write(ab)
            if (!ok) {
              stream.pause()
              res.onWritable(() => {
                stream.resume()
                return true
              })
            }
          })
          await once(stream, 'end')
          if (stream.readableAborted) {
            res.end(undefined, true)
          } else {
            res.end()
          }
        } else {
          res.cork(() => {
            if (ac.signal.aborted) return
            const status = HttpCode.OK
            const text = HttpStatusText[status]
            const buffer = format.encoder.encode(output)
            res.writeStatus(`${status} ${text}`)
            responseHeaders.set('Content-Type', format.encoder.contentType)
            setHeaders(res, responseHeaders)
            res.end(buffer)
          })
        }
      }
    } catch (error) {
      if (ac.signal.aborted) return
      if (error instanceof UnsupportedFormatError) {
        res.cork(() => {
          if (ac.signal.aborted) return
          const status =
            error instanceof UnsupportedContentTypeError
              ? HttpCode.UnsupportedMediaType
              : HttpCode.NotAcceptable
          const text = HttpStatusText[status]
          res.writeStatus(`${status} ${text}`)
          res.end()
        })
      } else if (error instanceof ProtocolError) {
        res.cork(() => {
          if (ac.signal.aborted) return
          const status =
            error.code in HttpCodeMap
              ? HttpCodeMap[error.code]
              : HttpCode.InternalServerError
          const text = HttpStatusText[status]
          res.writeStatus(`${status} ${text}`)
          res.end(format!.encoder.encode(error))
        })
      } else {
        this.logError(error, 'Unknown error while processing request')
        res.cork(() => {
          if (ac.signal.aborted) return
          const status = HttpCode.InternalServerError
          const text = HttpStatusText[status]
          const payload = format!.encoder.encode(
            new ProtocolError(
              ErrorCode.InternalServerError,
              'Internal Server Error',
            ),
          )
          res.writeStatus(`${status} ${text}`)
          res.end(payload)
        })
      }
    } finally {
      container.dispose().catch((error) => {
        this.logError(error, 'Error while disposing call container')
      })
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

  protected applyCors(res: HttpResponse, req: HttpRequest) {
    if (this.options.cors === false) return

    const origin = req.getHeader('origin')
    if (!origin) return

    let allowed = false

    if (this.options.cors === undefined || this.options.cors === true) {
      allowed = true
    } else if (Array.isArray(this.options.cors)) {
      allowed = this.options.cors.includes(origin)
    } else {
      allowed = this.options.cors(origin)
    }

    if (!allowed) return

    res.writeHeader('Access-Control-Allow-Origin', origin)
    res.writeHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.writeHeader('Access-Control-Allow-Methods', 'GET, POST')
    res.writeHeader('Access-Control-Allow-Credentials', 'true')
  }

  protected [ClientMessageType.Rpc](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    this.protocol.rpcRaw(id, buffer)
  }

  protected [ClientMessageType.RpcAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    this.protocol.rpcAbortRaw(id, buffer)
  }

  protected [ClientMessageType.RpcStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    this.protocol.rpcStreamAbortRaw(id, buffer)
  }

  protected [ClientMessageType.ClientStreamPush](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.pushClientStream(
      id,
      streamId,
      buffer.slice(Uint32Array.BYTES_PER_ELEMENT),
    )
  }

  protected [ClientMessageType.ClientStreamEnd](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.endClientStream(id, streamId)
  }

  protected [ClientMessageType.ClientStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.abortClientStream(id, streamId)
  }

  protected [ClientMessageType.ServerStreamPull](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.pullServerStream(id, streamId)
  }

  protected [ClientMessageType.ServerStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.abortServerStream(id, streamId)
  }
}
