import type { ClientTransport, ClientTransportStartParams } from '@nmtjs/client'
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
  /**
   * Custom WebSocket class
   * @default globalThis.WebSocket
   */
  wsFactory?: (url: URL) => WebSocket

  debug?: boolean
}

export class WsTransportClient {
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

    const ws = this.options.wsFactory
      ? this.options.wsFactory(url)
      : new WebSocket(url.toString())

    ws.binaryType = 'arraybuffer'

    this.connecting = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        params.onConnect()
        this.connecting = null
        resolve()
      })
      ws.addEventListener('message', (event) => {
        params.onMessage(new Uint8Array(event.data as ArrayBuffer))
      })
      ws.addEventListener('error', (event) => {
        reject(new Error('WebSocket error', { cause: event }))
      })
      ws.addEventListener('close', (event) => {
        params.onDisconnect(event.reason)
        this.webSocket = null
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

  async send(message: ArrayBufferView, signal: AbortSignal) {
    if (this.webSocket === null) throw new Error('WebSocket is not connected')
    await this.connecting
    if (!signal.aborted) this.webSocket!.send(message)
  }
}

type WsTransport = ClientTransport<
  ConnectionType.Bidirectional,
  WsClientTransportOptions
>

export default (<WsTransport>{
  type: ConnectionType.Bidirectional,
  factory(params, options) {
    return new WsTransportClient(params.format, params.protocol, options)
  },
})
