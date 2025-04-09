import type { AppOptions, WebSocket } from 'uWebSockets.js'
import type { Connection, ConnectionContext } from '@nmtjs/protocol/server'
import type { InteractivePromise } from '../../common/src/index.ts'

export type WsUserData = {
  id: Connection['id']
  opening: InteractivePromise<void>
  backpressure: InteractivePromise<void> | null
  request: {
    headers: Map<string, string>
    query: URLSearchParams
    remoteAddress: string
    proxiedRemoteAddress: string
    acceptType: string | null
    contentType: string | null
  }
  context: ConnectionContext
}

export type WsTransportSocket = WebSocket<WsUserData>

export type WsTransportOptions = {
  port?: number
  hostname?: string
  unix?: string
  tls?: AppOptions
  maxPayloadLength?: number
  maxStreamChunkLength?: number
}
