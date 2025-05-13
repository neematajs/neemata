import { ClientMessageType, concat, encodeNumber } from '@nmtjs/protocol'
import {
  type Protocol,
  type ProtocolBaseClientCallOptions,
  type ProtocolBaseTransformer,
  ProtocolTransport,
} from '@nmtjs/protocol/client'

export type WebSocketClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'http://localhost:3000'
   */
  origin: string
  /**
   * Whether to autoreconnect on close
   * @default true
   */
  autoreconnect?: boolean
  /**
   * Custom WebSocket class
   * @default globalThis.WebSocket
   */
  wsFactory?: (url: URL) => WebSocket

  debug?: boolean
}

export class WebSocketClientTransport extends ProtocolTransport {
  protected webSocket: WebSocket | null = null
  protected connecting: Promise<void> | null = null

  constructor(
    protected readonly protocol: Protocol,
    protected readonly options: WebSocketClientTransportOptions,
  ) {
    super()
  }

  connect(auth: any, transformer: ProtocolBaseTransformer): Promise<void> {
    const wsUrl = new URL('/api', this.options.origin)
    if (this.protocol.contentType) {
      wsUrl.searchParams.set('content-type', this.protocol.contentType)
      wsUrl.searchParams.set('accept', this.protocol.contentType)
    }
    if (auth) wsUrl.searchParams.set('auth', auth)

    const ws =
      this.options.wsFactory?.(wsUrl) ?? new WebSocket(wsUrl.toString())

    ws.binaryType = 'arraybuffer'

    ws.addEventListener('message', ({ data }) => {
      this.protocol.handleServerMessage(data as ArrayBuffer, this, transformer)
    })

    this.webSocket = ws

    this.connecting = new Promise((resolve, reject) => {
      ws.addEventListener(
        'open',
        () => {
          this.protocol.emit('connected')
          resolve()
        },
        { once: true },
      )

      ws.addEventListener(
        'error',
        (event) => {
          reject(new Error('WebSocket error', { cause: event }))
        },
        { once: true },
      )

      ws.addEventListener(
        'close',
        (event) => {
          this.protocol.emit('disconnected')
          this.webSocket = null
          if (this.options.autoreconnect === true) {
            setTimeout(this.connect.bind(this), 1000)
          }
        },
        { once: true },
      )
    })

    return this.connecting
  }

  async disconnect(): Promise<void> {
    if (this.webSocket === null) return
    this.webSocket!.close()
    return _once(this.webSocket, 'close')
  }

  async call(
    namespace: string,
    procedure: string,
    payload: any,
    options: ProtocolBaseClientCallOptions,
    transformer: ProtocolBaseTransformer,
  ) {
    const { call, buffer } = this.protocol.createRpc(
      namespace,
      procedure,
      payload,
      options,
      transformer,
    )
    await this.send(ClientMessageType.Rpc, buffer)
    return call
  }

  async send(
    messageType: ClientMessageType,
    buffer: ArrayBuffer,
  ): Promise<void> {
    if (this.connecting) await this.connecting
    this.webSocket!.send(concat(encodeNumber(messageType, 'Uint8'), buffer))
  }
}

function _once(target: EventTarget, event: string) {
  return new Promise<void>((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true })
  })
}
