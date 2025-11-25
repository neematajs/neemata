import type {
  ClientTransport,
  ClientTransportInstance,
  ClientTransportRpcParams,
} from '@nmtjs/client'
import type { ProtocolVersion } from '@nmtjs/protocol'
import type { BaseClientFormat } from '@nmtjs/protocol/client'
import { ConnectionType, ProtocolBlob } from '@nmtjs/protocol'

// import { ConnectionType } from '../../protocol/src/common/enums.ts'

export type HttpClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'http://localhost:3000'
   */
  url: string
  debug?: boolean
}

const addStream = () => {
  throw new Error('HTTP transport does not support streams')
}
const getStream = () => {
  throw new Error('HTTP transport does not support streams')
}

export class HttpTransportClient
  implements ClientTransportInstance<ConnectionType.Unidirectional>
{
  constructor(
    protected readonly format: BaseClientFormat,
    protected readonly protocol: ProtocolVersion,
    protected options: HttpClientTransportOptions,
  ) {
    this.options = { debug: false, ...options }
  }

  async call(
    params: ClientTransportRpcParams,
    rpc: { callId: number; procedure: string; payload: unknown },
    signal: AbortSignal,
  ) {
    const { procedure, payload } = rpc
    const requestHeaders = new Headers()

    if (params.auth) requestHeaders.set('Authorization', params.auth)
    const base = params.application
      ? `/${params.application}/${procedure}`
      : `/${procedure}`
    const url = new URL(base, this.options.url)

    let body: any

    if (payload instanceof ProtocolBlob) {
      requestHeaders.set('Content-Type', payload.metadata.type)
    } else {
      requestHeaders.set('Content-Type', params.format.contentType)

      const { buffer, streams } = params.format.encodeRPC(payload, {
        addStream,
        getStream,
      })

      if (Object.keys(streams).length > 0) {
        throw new Error('HTTP transport does not encoded streams')
      }

      body = buffer
    }

    const response = await fetch(url.toString(), {
      body,
      method: 'POST',
      headers: requestHeaders,
      signal,
    })

    if (response.ok) {
      const isBlob =
        response.headers.get('content-type') !== params.format.contentType

      // TODO: implement rpc streams via SSE

      if (isBlob) {
        const contentLength = response.headers.get('content-length')
        const size = contentLength
          ? Number.parseInt(contentLength, 10) || undefined
          : undefined
        const type =
          response.headers.get('content-type') || 'application/octet-stream'
        const disposition = response.headers.get('content-disposition')
        let filename: string | undefined
        if (disposition) {
          const match = disposition.match(/filename="?([^"]+)"?/)
          if (match) filename = match[1]
          return new ProtocolBlob(response.body, size, type, filename)
        }
      } else {
        const decoded = params.format.decodeRPC(await response.bytes(), {
          addStream,
          getStream,
        })
        return decoded
      }
    }
  }
}

export type HttpTransport = ClientTransport<
  ConnectionType.Unidirectional,
  HttpClientTransportOptions
>

export default (<HttpTransport>{
  type: ConnectionType.Unidirectional,
  factory(params, options) {
    return new HttpTransportClient(params.format, params.protocol, options)
  },
})
