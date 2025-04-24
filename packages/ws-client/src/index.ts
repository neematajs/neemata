import {
  type BaseClientFormat,
  EventEmitter,
  type ProtocolTransport,
  type ProtocolTransportEventMap,
} from '@nmtjs/protocol/client'
import {
  type ClientMessageType,
  concat,
  decodeNumber,
  encodeNumber,
  ServerMessageType,
} from '@nmtjs/protocol/common'

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

export class WebSocketClientTransport
  extends EventEmitter<ProtocolTransportEventMap>
  implements ProtocolTransport
{
  #webSocket: WebSocket | null = null
  #connecting: Promise<void> | null = null

  constructor(private readonly options: WebSocketClientTransportOptions) {
    super()
  }

  connect(
    auth: string | undefined = undefined,
    contentType: BaseClientFormat['contentType'],
  ): Promise<void> {
    const wsUrl = new URL(this.options.origin)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    wsUrl.pathname = '/api'
    wsUrl.searchParams.set('content-type', contentType)
    wsUrl.searchParams.set('accept', contentType)
    if (auth) wsUrl.searchParams.set('auth', auth)

    const ws =
      this.options.wsFactory?.(wsUrl) ?? new WebSocket(wsUrl.toString())

    ws.binaryType = 'arraybuffer'

    ws.addEventListener('message', ({ data }) => {
      const buffer: ArrayBuffer = data
      const type = decodeNumber(buffer, 'Uint8')
      if (type in ServerMessageType) {
        this.emit(`${type}`, buffer.slice(Uint8Array.BYTES_PER_ELEMENT))
      }
    })

    this.#webSocket = ws

    this.#connecting = new Promise((resolve, reject) => {
      ws.addEventListener(
        'open',
        () => {
          this.emit('connected')
          resolve()
        },
        { once: true },
      )

      ws.addEventListener(
        'error',
        (event) => reject(new Error('WebSocket error', { cause: event })),
        { once: true },
      )

      ws.addEventListener(
        'close',
        (event) => {
          this.emit('disconnected')
          this.#webSocket = null
          if (this.options.autoreconnect === true) {
            setTimeout(() => this.connect(auth, contentType), 1000)
          }
        },
        { once: true },
      )
    })

    return this.#connecting
  }

  async disconnect(): Promise<void> {
    if (this.#webSocket === null) return
    this.#webSocket!.close()
    return _once(this.#webSocket, 'close')
  }

  async send(
    messageType: ClientMessageType,
    buffer: ArrayBuffer,
  ): Promise<void> {
    if (this.#connecting) await this.#connecting
    this.#webSocket!.send(concat(encodeNumber(messageType, 'Uint8'), buffer))
  }
}

function _once(target: EventTarget, event: string) {
  return new Promise<void>((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true })
  })
}
