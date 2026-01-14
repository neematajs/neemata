import type {
  ClientCallOptions,
  ClientTransportFactory,
  ClientTransportStartParams,
} from '@nmtjs/client'
import type { ProtocolVersion } from '@nmtjs/protocol'
import type { BaseClientFormat } from '@nmtjs/protocol/client'
import { once } from '@nmtjs/common'
import { ConnectionType } from '@nmtjs/protocol'

export type WsClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'ws://localhost:3000'
   */
  url: string
  debug?: boolean

  /**
   * Custom WebSocket class
   * @default globalThis.WebSocket
   */
  WebSocket?: typeof WebSocket
}

export class WsTransportClient {
  type: ConnectionType.Bidirectional = ConnectionType.Bidirectional

  protected webSocket: WebSocket | null = null
  protected connecting: Promise<void> | null = null

  constructor(
    protected readonly format: BaseClientFormat,
    protected readonly protocol: ProtocolVersion,
    protected options: WsClientTransportOptions,
  ) {
    this.options = { debug: false, ...options }
  }

  async connect(params: ClientTransportStartParams) {
    const url = new URL(
      params.application ? `/${params.application}` : '/',
      this.options.url,
    )

    const secure = url.protocol === 'wss:' || url.protocol === 'https:'

    url.protocol = secure ? 'wss:' : 'ws:'
    url.searchParams.set('content-type', this.format.contentType)
    url.searchParams.set('accept', this.format.contentType)

    if (params.auth) {
      url.searchParams.set('auth', params.auth)
    }

    const ws = this.options.WebSocket
      ? new this.options.WebSocket(url)
      : new WebSocket(url.toString())

    ws.binaryType = 'arraybuffer'

    this.connecting = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        this.connecting = null
        params.onConnect()
        resolve()
      })
      ws.addEventListener('message', (event) => {
        params.onMessage(new Uint8Array(event.data as ArrayBuffer))
      })
      ws.addEventListener('error', (event) => {
        this.connecting = null
        reject(
          new Error('WebSocket error', { cause: (event as ErrorEvent).error }),
        )
      })
      ws.addEventListener('close', (event) => {
        this.webSocket = null
        this.connecting = null
        params.onDisconnect('server')
      })
    })

    this.webSocket = ws

    return this.connecting
  }

  async disconnect() {
    if (this.webSocket === null) return
    const closing = once(this.webSocket, 'close')
    this.webSocket!.close(1000, 'client')
    return closing
  }

  async send(message: ArrayBufferView, options: ClientCallOptions) {
    if (this.webSocket === null) throw new Error('WebSocket is not connected')
    await this.connecting
    if (!options.signal?.aborted) this.webSocket!.send(message)
  }
}

export type WsTransportFactory = ClientTransportFactory<
  ConnectionType.Bidirectional,
  WsClientTransportOptions,
  WsTransportClient
>

export const WsTransportFactory: WsTransportFactory = (params, options) =>
  new WsTransportClient(params.format, params.protocol, options)
