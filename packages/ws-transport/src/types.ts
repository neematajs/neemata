import type { AppOptions, WebSocket } from 'uWebSockets.js'
import type { Connection, ConnectionContext } from '@nmtjs/protocol/server'
import type { InteractivePromise } from '../../common/src/index.ts'
import type { RequestData } from './utils.ts'

export type WsConnectionData = { type: 'ws' | 'http' }

export type WsUserData = {
  id: Connection['id']
  backpressure: InteractivePromise<void> | null
  request: RequestData
  acceptType: string | null
  contentType: string | null
  context: ConnectionContext
  controller: AbortController
}

export type WsTransportSocket = WebSocket<WsUserData>

export type WsTransportOptions = {
  port?: number
  hostname?: string
  unix?: string
  tls?: AppOptions
  cors?: boolean | string[] | ((origin: string) => boolean)
  maxPayloadLength?: number
  maxStreamChunkLength?: number
}
