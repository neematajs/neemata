import type { ClientMessageType } from '@nmtjs/protocol'
import type {
  BaseProtocol,
  ProtocolBaseClientCallOptions,
  ProtocolBaseTransformer,
  ProtocolClientCall,
  ProtocolSendMetadata,
  ProtocolTransport,
  ProtocolTransportEventMap,
} from '@nmtjs/protocol/client'
import { ClientError } from '@nmtjs/client'
import { ErrorCode, ProtocolBlob } from '@nmtjs/protocol'
import {
  EventEmitter,
  ProtocolServerBlobStream,
  ProtocolTransportStatus,
} from '@nmtjs/protocol/client'

export type HttpClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'http://localhost:3000'
   */
  origin: string
  debug?: boolean
}

export class HttpClientTransport
  extends EventEmitter<ProtocolTransportEventMap>
  implements ProtocolTransport
{
  #auth: string | null = null
  status: ProtocolTransportStatus = ProtocolTransportStatus.CONNECTED

  constructor(
    protected readonly protocol: BaseProtocol,
    private readonly options: HttpClientTransportOptions,
  ) {
    super()
  }

  async call(
    procedure: string,
    payload: any,
    options: ProtocolBaseClientCallOptions,
    transformer: ProtocolBaseTransformer,
  ): Promise<ProtocolClientCall> {
    const call = this.protocol.createCall(procedure, options)

    const headers = new Headers()

    headers.set('Content-Type', this.protocol.contentType)
    headers.set('Accept', this.protocol.contentType)

    if (this.#auth) headers.set('Authorization', this.#auth)

    const isBlob = payload instanceof ProtocolBlob
    if (isBlob) headers.set('x-neemata-blob', 'true')

    const response = fetch(`${this.options.origin}/api/${procedure}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: isBlob ? payload.source : transformer.encodeRPC(procedure, payload),
      signal: call.signal,
      // @ts-expect-error
      duplex: 'half',
    })

    response
      .catch((error) =>
        Promise.reject(new Error('Network error', { cause: error })),
      )
      .then((response) => {
        const isBlob = response.headers.get('x-neemata-blob') === 'true'
        if (isBlob) {
          const contentLength = response.headers.get('content-length')
          const size = contentLength
            ? Number.parseInt(contentLength) || undefined
            : undefined
          const type =
            response.headers.get('content-type') || 'application/octet-stream'
          const stream = new ProtocolServerBlobStream(-1, { size, type })
          response.body?.pipeThrough(stream)
          return stream
        } else {
          const body = response.arrayBuffer()
          return body.then((buffer) => {
            if (response.ok) {
              const decoded = this.protocol.format.decode(buffer)
              return transformer.decodeRPC(procedure, decoded)
            } else {
              if (buffer.byteLength === 0) {
                const error = new ClientError(
                  ErrorCode.InternalServerError,
                  `Empty response with ${response.status} status code`,
                )
                return Promise.reject(error)
              } else {
                const payload = this.protocol.format.decode(buffer)
                const error = new ClientError(
                  payload.code,
                  payload.message,
                  payload.data,
                )
                return Promise.reject(error)
              }
            }
          })
        }
      })
      .then(call.resolve)
      .catch(call.reject)

    return call
  }

  async connect(auth: any) {
    this.#auth = auth
    this.emit('connected')
  }

  async disconnect() {
    this.emit('disconnected', 'client')
  }

  async send(
    _messageType: ClientMessageType,
    _buffer: ArrayBuffer,
    _metadata: ProtocolSendMetadata,
  ) {
    throw new Error('Not supported')
  }
}
