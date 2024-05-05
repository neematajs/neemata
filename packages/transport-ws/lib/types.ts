import type { Readable } from 'node:stream'
import type {
  BaseTransportConnection,
  Callback,
  Container,
  Stream,
  Subscription,
} from '@neematajs-bun/application'
import type { ServerWebSocket, SocketAddress, TLSOptions } from 'bun'
import type { HttpTransportMethod } from './constants'

export type HttpTransportOptions = {
  port?: number
  hostname?: string
  tls?: TLSOptions
  maxPayloadLength?: number
  maxStreamChunkLength?: number
}

export type HttpTransportProcedureOptions = {
  allowHttp: HttpTransportMethod
}

export type HttpTransportData = {
  transport: 'http'
  headers: Record<string, string>
  query: URLSearchParams
  ip: SocketAddress | null
  method: HttpTransportMethod
}

export type WsUserData = {
  id: BaseTransportConnection['id']
  backpressure: null | {
    promise: Promise<void>
    resolve: Callback
  }
  streams: {
    /**
     * Client to server streams
     */
    up: Map<number, Stream>
    /**
     * Server to client streams
     */
    down: Map<number, Readable>
    streamId: number
  }
  subscriptions: Map<string, Subscription>
  container: Container
  transportData: WsTransportData
}

export type WsTransportSocket = ServerWebSocket<WsUserData>

export type WsTransportOptions = HttpTransportOptions & {
  enableHttp?: boolean
}

export type WsTransportData = {
  transport: 'websockets'
  headers: Record<string, string>
  query: URLSearchParams
}
