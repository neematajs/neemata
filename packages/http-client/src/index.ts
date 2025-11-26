import type {
  ClientCallOptions,
  ClientTransport,
  ClientTransportFactory,
  ClientTransportRpcParams,
} from '@nmtjs/client'
import type { ProtocolVersion } from '@nmtjs/protocol'
import type { BaseClientFormat } from '@nmtjs/protocol/client'
import { createFuture } from '@nmtjs/common'
import { ConnectionType, ProtocolBlob } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/client'

type DecodeBase64Function = (data: string) => ArrayBufferView

const createDecodeBase64 = (customFn?: DecodeBase64Function) => {
  return (string: string) => {
    if (typeof Uint8Array.fromBase64 === 'function') {
      return Uint8Array.fromBase64(string)
    } else if (typeof atob === 'function') {
      return Uint8Array.from(atob(string), (c) => c.charCodeAt(0))
    } else if (customFn) {
      return customFn(string)
    } else {
      throw new Error('No base64 decoding function available')
    }
  }
}

const NEEMATA_BLOB_HEADER = 'X-Neemata-Blob'

export type HttpClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'http://localhost:3000'
   */
  url: string
  debug?: boolean
  EventSource?: typeof EventSource
  decodeBase64?: DecodeBase64Function
}

export class HttpTransportClient
  implements ClientTransport<ConnectionType.Unidirectional>
{
  type: ConnectionType.Unidirectional = ConnectionType.Unidirectional
  decodeBase64: DecodeBase64Function

  constructor(
    protected readonly format: BaseClientFormat,
    protected readonly protocol: ProtocolVersion,
    protected options: HttpClientTransportOptions,
  ) {
    this.options = { debug: false, ...options }
    this.decodeBase64 = createDecodeBase64(options.decodeBase64)
  }

  url({ procedure, application }: { application?: string; procedure: string }) {
    const base = application ? `/${application}/${procedure}` : `/${procedure}`
    const url = new URL(base, this.options.url)
    return url
  }

  async call(
    client: ClientTransportRpcParams,
    rpc: { callId: number; procedure: string; payload: unknown },
    options: ClientCallOptions,
  ) {
    const { procedure, payload } = rpc
    const requestHeaders = new Headers()

    const url = this.url({ application: client.application, procedure })

    if (client.auth) requestHeaders.set('Authorization', client.auth)

    let body: any

    if (payload instanceof ProtocolBlob) {
      requestHeaders.set('Content-Type', payload.metadata.type)
      requestHeaders.set(NEEMATA_BLOB_HEADER, 'true')
    } else {
      requestHeaders.set('Content-Type', client.format.contentType)
      const buffer = client.format.encode(payload)
      body = buffer
    }

    if (options._stream_response) {
      const _constructor = this.options.EventSource
        ? this.options.EventSource
        : EventSource
      const source = new _constructor(url.toString(), { withCredentials: true })
      const future = createFuture<{
        type: 'rpc_stream'
        stream: ReadableStream<ArrayBufferView>
      }>()
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      source.addEventListener('open', () =>
        future.resolve({ type: 'rpc_stream', stream: readable }),
      )
      source.addEventListener('close', () => writable.close())
      source.addEventListener('error', (event) => {
        const error = new Error('Stream error', { cause: event })
        future.reject(error)
        writable.abort(error)
      })
      source.addEventListener('message', (event) => {
        try {
          const buffer = this.decodeBase64(event.data)
          writer.write(buffer)
        } catch (cause) {
          const error = new Error('Failed to decode stream message', { cause })
          writable.abort(error)
        }
      })
      return future.promise
    } else {
      const response = await fetch(url.toString(), {
        body,
        method: 'POST',
        headers: requestHeaders,
        signal: options.signal,
        credentials: 'include',
        keepalive: true,
      })

      if (response.ok) {
        const isBlob = !!response.headers.get(NEEMATA_BLOB_HEADER)
        if (isBlob) {
          const contentLength = response.headers.get('content-length')
          const size =
            (contentLength && Number.parseInt(contentLength, 10)) || undefined
          const type =
            response.headers.get('content-type') || 'application/octet-stream'
          const disposition = response.headers.get('content-disposition')
          let filename: string | undefined
          if (disposition) {
            const match = disposition.match(/filename="?([^"]+)"?/)
            if (match) filename = match[1]
          }
          return {
            type: 'blob' as const,
            metadata: { type, size, filename },
            source: body,
          }
        } else {
          return { type: 'rpc' as const, result: await response.bytes() }
        }
      } else {
        const decoded = await response.text()
        // throw new ProtocolError()
        throw new Error()
      }
    }
  }
}

export type HttpTransportFactory = ClientTransportFactory<
  ConnectionType.Unidirectional,
  HttpClientTransportOptions,
  HttpTransportClient
>

export const HttpTransportFactory: HttpTransportFactory = (params, options) => {
  return new HttpTransportClient(params.format, params.protocol, options)
}
