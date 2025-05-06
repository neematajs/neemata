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
  WsTransportOptions,
  WsTransportSocket,
  WsUserData,
} from './types.ts'
import { getRequestData, send } from './utils.ts'

export type WsConnectionData = {}

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
        upgrade: (res, req, context) => {
          const requestData = getRequestData(req)

          const contentType =
            requestData.headers.get('content-type') ||
            requestData.query.get('content-type')

          const acceptType =
            requestData.headers.get('accept') || requestData.query.get('accept')

          const data: WsUserData = {
            id: randomUUID(),
            request: {
              query: requestData.query,
              headers: requestData.headers,
              proxiedRemoteAddress: Buffer.from(
                res.getProxiedRemoteAddressAsText(),
              ).toString(),
              remoteAddress: Buffer.from(
                res.getRemoteAddressAsText(),
              ).toString(),
              contentType,
              acceptType,
            },
            opening: createPromise(),
            backpressure: null,
            context: {} as any,
          }

          res.upgrade(
            data,
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context,
          )
        },
        open: async (ws: WsTransportSocket) => {
          const { id, context, request, opening } = ws.getUserData()
          this.clients.set(id, ws)
          this.logger.debug('Connection %s opened', id)
          try {
            const { context: _context, connection } =
              await this.context.protocol.connections.add(
                this,
                { id, data: {} },
                {
                  acceptType: request.acceptType,
                  contentType: request.contentType,
                },
              )
            Object.assign(context, _context)
            context.container.provide(
              ProtocolInjectables.connection,
              connection,
            )
            context.container.provide(
              WsTransportInjectables.connectionData,
              request,
            )
            opening.resolve()
          } catch (error) {
            opening.reject(error)
          }
        },
        message: async (ws: WsTransportSocket, buffer) => {
          const { opening } = ws.getUserData()
          const messageType = decodeNumber(buffer, 'Uint8')
          if (messageType in this === false) {
            ws.end(1011, 'Unknown message type')
          } else {
            try {
              await opening.promise
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
          await this.protocol.connections.remove(id)
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
    cause: Error,
    message = 'Unknown error while processing request',
  ) {
    this.logger.error(new Error(message, { cause }))
  }

  protected applyCors(res: HttpResponse, req: HttpRequest) {
    // TODO: this should be configurable
    const origin = req.getHeader('origin')
    if (!origin) return
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
    this.protocol.clientStreams.push(
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
    this.protocol.clientStreams.end(id, streamId)
  }

  protected [ClientMessageType.ClientStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.clientStreams.abort(id, streamId)
  }

  protected [ClientMessageType.ServerStreamPull](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.serverStreams.pull(id, streamId)
  }

  protected [ClientMessageType.ServerStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const { id } = ws.getUserData()
    const streamId = decodeNumber(buffer, 'Uint32')
    this.protocol.serverStreams.abort(id, streamId)
  }
}
