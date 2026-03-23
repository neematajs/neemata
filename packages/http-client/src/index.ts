import type {
  ClientTransportFactory,
  TransportCallContext,
  TransportCallOptions,
  TransportRpcParams,
  UnidirectionalTransport,
} from '@nmtjs/client'
import type { ProtocolVersion } from '@nmtjs/protocol'
import type { BaseClientFormat } from '@nmtjs/protocol/client'
import { ConnectionType, ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/client'

import { HttpStreamParser } from './http-stream-parser.ts'

type DecodeBase64Function = (data: string) => ArrayBufferView

const createDecodeBase64 = (
  customFn?: DecodeBase64Function,
): DecodeBase64Function => {
  return (string: string) => {
    if (
      'fromBase64' in Uint8Array &&
      typeof Uint8Array.fromBase64 === 'function'
    ) {
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
  fetch?: typeof fetch
  decodeBase64?: DecodeBase64Function
}

export class HttpTransportClient implements UnidirectionalTransport {
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

  private getFetch(): typeof fetch {
    const implementation = this.options.fetch ?? globalThis.fetch
    if (!implementation) {
      throw new Error(
        'Fetch API is not available. Provide HttpClientTransportOptions.fetch',
      )
    }
    return implementation
  }

  url({ procedure, application }: { procedure: string; application?: string }) {
    const base = application ? `/${application}/${procedure}` : `/${procedure}`
    const url = new URL(base, this.options.url)
    return url
  }

  async call(
    context: TransportCallContext,
    rpc: TransportRpcParams,
    options: TransportCallOptions,
  ) {
    const { procedure, payload } = rpc
    const requestHeaders = new Headers()
    const fetchImpl = this.getFetch()

    const url = this.url({ application: context.application, procedure })

    if (context.auth) requestHeaders.set('Authorization', context.auth)
    requestHeaders.set('Accept', context.contentType)

    let body: any

    if (rpc.blob) {
      requestHeaders.set('Content-Type', rpc.blob.metadata.type)
      requestHeaders.set(NEEMATA_BLOB_HEADER, 'true')
      body = rpc.blob.source
    } else {
      requestHeaders.set('Content-Type', context.contentType)
      body = new Uint8Array(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
      )
    }

    if (options.streamResponse) {
      const response = await fetchImpl(url.toString(), {
        body,
        method: 'POST',
        headers: requestHeaders,
        signal: options.signal,
        credentials: 'include',
        keepalive: true,
      })

      if (!response.ok) {
        return {
          type: 'error' as const,
          error: await response.bytes().catch(() => new Uint8Array(0)),
          status: response.status,
          statusText: response.statusText,
        }
      }

      if (!response.body) {
        throw new ProtocolError(
          ErrorCode.ClientRequestError,
          'Empty stream response body',
        )
      }

      const stream = new ReadableStream<ArrayBufferView>({
        start: async (controller) => {
          const reader = response.body!.getReader()
          const decoder = new TextDecoder()
          const parser = new HttpStreamParser()

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              const chunk = decoder.decode(value, { stream: true })
              parser.push(chunk, (eventData) => {
                controller.enqueue(this.decodeBase64(eventData))
              })
            }

            const tail = decoder.decode()
            parser.push(tail, (eventData) => {
              controller.enqueue(this.decodeBase64(eventData))
            })
            parser.finish((eventData) => {
              controller.enqueue(this.decodeBase64(eventData))
            })

            controller.close()
          } catch (cause) {
            controller.error(new Error('Stream error', { cause }))
          } finally {
            reader.releaseLock()
          }
        },
        cancel: async () => {
          try {
            await response.body?.cancel()
          } catch {}
        },
      })

      return { type: 'rpc_stream' as const, stream }
    } else {
      const response = await fetchImpl(url.toString(), {
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
            source: response.body!,
          }
        } else {
          return { type: 'rpc' as const, result: await response.bytes() }
        }
      } else {
        return {
          type: 'error' as const,
          error: await response.bytes().catch(() => new Uint8Array(0)),
          status: response.status,
          statusText: response.statusText,
        }
      }
    }
  }
}

export type HttpTransportFactory = ClientTransportFactory<
  HttpTransportClient,
  HttpClientTransportOptions
>

export const HttpTransportFactory: HttpTransportFactory = (params, options) => {
  return new HttpTransportClient(params.format, params.protocol, options)
}
