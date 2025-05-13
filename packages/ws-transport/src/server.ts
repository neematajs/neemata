import {
  App,
  type HttpRequest,
  type HttpResponse,
  SSLApp,
  type TemplatedApp,
  us_socket_local_port,
} from 'uWebSockets.js'
import { randomUUID } from 'node:crypto'
import { createPromise } from '@nmtjs/common'
import {
  ClientMessageType,
  decodeNumber,
  type ServerMessageType,
} from '@nmtjs/protocol/common'
import {
  type Connection,
  ProtocolInjectables,
  type Transport,
  type TransportPluginContext,
} from '@nmtjs/protocol/server'
import { WsTransportInjectables } from './injectables.ts'
import type {
  WsConnectionData,
  WsTransportOptions,
  WsTransportSocket,
  WsUserData,
} from './types.ts'
import { getRequestData, send } from './utils.ts'

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
