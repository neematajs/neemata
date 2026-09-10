import type { ProtocolVersion } from '@nmtjs/protocol'
import type { BaseClientCodec } from '@nmtjs/protocol/client'
import { ConnectionType, ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/client'

import type {
  ClientTransportFactory,
  TransportCallContext,
  TransportCallOptions,
  TransportRpcParams,
  UnidirectionalTransport,
} from '../../transport.ts'
import { HttpStreamParser } from './stream-parser.ts'

type DecodeBase64 = (data: string) => ArrayBufferView

const createDecodeBase64 = (custom?: DecodeBase64): DecodeBase64 => {
  // caller-supplied decoder must win over built-ins
  if (custom) return custom

  return (string: string) => {
    if (
      'fromBase64' in Uint8Array &&
      typeof Uint8Array.fromBase64 === 'function'
    ) {
      return Uint8Array.fromBase64(string)
    } else if (typeof atob === 'function') {
      return Uint8Array.from(atob(string), (c) => c.charCodeAt(0))
    } else {
      throw new Error('No base64 decoding function available')
    }
  }
}

const NEEMATA_BLOB_HEADER = 'X-Neemata-Blob'
const MAX_KEEPALIVE_BODY_BYTES = 64 * 1024

const getBodyByteLength = (body: unknown): number | undefined => {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body).byteLength
  }

  if (ArrayBuffer.isView(body)) {
    return body.byteLength
  }

  if (body instanceof ArrayBuffer) {
    return body.byteLength
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.size
  }

  if (
    typeof URLSearchParams !== 'undefined' &&
    body instanceof URLSearchParams
  ) {
    return new TextEncoder().encode(body.toString()).byteLength
  }

  return undefined
}

const shouldUseKeepalive = (body: unknown): boolean => {
  const byteLength = getBodyByteLength(body)
  return byteLength !== undefined && byteLength <= MAX_KEEPALIVE_BODY_BYTES
}

export type HttpClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'http://localhost:3000'
   */
  url: string
  debug?: boolean
  EventSource?: typeof EventSource
  fetch?: typeof fetch
  decodeBase64?: DecodeBase64
}

export class HttpTransportClient implements UnidirectionalTransport {
  type: ConnectionType.Unidirectional = ConnectionType.Unidirectional
  decodeBase64: DecodeBase64

  constructor(
    protected readonly codec: BaseClientCodec,
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
    const headers = new Headers()
    const fetch = this.getFetch()

    const url = this.url({ application: context.application, procedure })

    if (context.auth) headers.set('Authorization', context.auth)
    headers.set('Accept', context.contentType)

    let body: any

    if (rpc.blob) {
      headers.set('Content-Type', rpc.blob.metadata.type)
      headers.set(NEEMATA_BLOB_HEADER, 'true')
      body = rpc.blob.source
    } else {
      headers.set('Content-Type', context.contentType)
      body = new Uint8Array(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
      )
    }

    // duplex is required by fetch for stream bodies but missing from RequestInit typings
    const request: RequestInit & { duplex?: 'half' } = {
      body,
      method: 'POST',
      headers,
      signal: options.signal,
      credentials: 'include',
    }

    // keepalive is opt-in: browsers cap total in-flight keepalive bytes at ~64KB
    if (options.keepalive && shouldUseKeepalive(body)) request.keepalive = true
    // undici and Chrome throw on stream request bodies without half-duplex
    if (rpc.blob) request.duplex = 'half'

    const streamResponse = options.streamResponse
    const response = await fetch(url.toString(), request)

    if (!response.ok) {
      const error = await response.bytes().catch(() => new Uint8Array(0))
      const { status, statusText } = response
      return { type: 'error' as const, error, status, statusText }
    }

    if (streamResponse) {
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
          const emit = (data: string) => {
            controller.enqueue(this.decodeBase64(data))
          }

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              const chunk = decoder.decode(value, { stream: true })
              parser.push(chunk, emit)
            }

            const tail = decoder.decode()
            parser.push(tail, emit)
            parser.finish(emit)

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
    }

    const isBlob = !!response.headers.get(NEEMATA_BLOB_HEADER)
    if (!isBlob) {
      const result = await response.bytes()
      return { type: 'rpc' as const, result }
    }

    const contentLength = response.headers.get('content-length')
    // distinguish a missing header from a valid zero-byte blob size
    const length = contentLength
      ? Number.parseInt(contentLength, 10)
      : Number.NaN
    const size = Number.isNaN(length) ? undefined : length
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
  }
}

export type HttpTransportFactory = ClientTransportFactory<
  HttpTransportClient,
  HttpClientTransportOptions
>

export const HttpTransportFactory: HttpTransportFactory = (params, options) => {
  return new HttpTransportClient(params.codec, params.protocol, options)
}
