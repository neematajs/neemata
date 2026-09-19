import type { BaseClientCodec } from '@nmtjs/protocol/client'
import { BLOB_HEADER, ConnectionType, ErrorCode } from '@nmtjs/protocol'
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

const decodeWithAtob = (data: string) => {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
}

// resolved once: the choice cannot change between chunks
const resolveDecodeBase64 = (custom?: DecodeBase64): DecodeBase64 => {
  // caller-supplied decoder must win over built-ins
  if (custom) return custom
  if ('fromBase64' in Uint8Array) {
    const fromBase64 = Uint8Array.fromBase64
    if (typeof fromBase64 === 'function') return (data) => fromBase64(data)
  }
  if (typeof atob === 'function') return decodeWithAtob

  return () => {
    throw new Error('No base64 decoding function available')
  }
}

const MAX_KEEPALIVE_BODY_BYTES = 64 * 1024

export type HttpClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'http://localhost:3000'
   */
  url: string
  fetch?: typeof fetch
  decodeBase64?: DecodeBase64
}

export class HttpTransportClient implements UnidirectionalTransport {
  type: ConnectionType.Unidirectional = ConnectionType.Unidirectional
  readonly decodeBase64: DecodeBase64

  constructor(
    protected readonly codec: BaseClientCodec,
    protected readonly options: HttpClientTransportOptions,
  ) {
    this.decodeBase64 = resolveDecodeBase64(options.decodeBase64)
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
    return new URL(base, this.options.url)
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

    let body: BodyInit

    if (rpc.blob) {
      headers.set('Content-Type', rpc.blob.metadata.type)
      headers.set(BLOB_HEADER, 'true')
      body = rpc.blob.source
    } else {
      headers.set('Content-Type', context.contentType)
      // fetch's typing rejects views over shared memory, which cannot occur here
      body = new Uint8Array(
        payload.buffer as ArrayBuffer,
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
    if (
      options.keepalive &&
      !rpc.blob &&
      payload.byteLength <= MAX_KEEPALIVE_BODY_BYTES
    ) {
      request.keepalive = true
    }
    // undici and Chrome throw on stream request bodies without half-duplex
    if (rpc.blob) request.duplex = 'half'

    // read before awaiting: the caller may reuse and mutate its options object
    const streamResponse = options.streamResponse
    const response = await fetch(url.toString(), request)

    if (!response.ok) {
      const error = await response.bytes().catch(() => new Uint8Array(0))
      const { status, statusText } = response
      return { type: 'error' as const, error, status, statusText }
    }

    if (streamResponse) {
      return { type: 'rpc_stream' as const, stream: this.toStream(response) }
    }

    if (!response.headers.get(BLOB_HEADER)) {
      const result = await response.bytes()
      return { type: 'rpc' as const, result }
    }

    return this.toBlob(response)
  }

  private toStream(response: Response) {
    const body = response.body
    if (!body) {
      throw new ProtocolError(
        ErrorCode.ClientRequestError,
        'Empty stream response body',
      )
    }

    return new ReadableStream<ArrayBufferView>({
      start: async (controller) => {
        const reader = body.getReader()
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
          await body.cancel()
        } catch {}
      },
    })
  }

  private toBlob(response: Response) {
    const contentLength = Number.parseInt(
      response.headers.get('content-length') ?? '',
      10,
    )
    // a missing or malformed header is not a valid zero-byte blob size
    const size = Number.isNaN(contentLength) ? undefined : contentLength
    const type =
      response.headers.get('content-type') || 'application/octet-stream'
    const disposition = response.headers.get('content-disposition')
    const filename = disposition?.match(/filename="?([^"]+)"?/)?.[1]

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
  return new HttpTransportClient(params.codec, options)
}
