import { Buffer } from 'node:buffer'
import { Duplex, Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type {
  GatewayResolvedProcedure,
  GatewayStaticMetaView,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  ProtocolCodecRegistry,
} from '@nmtjs/protocol/server'
import {
  anyAbortSignal,
  isAbortError,
  isAsyncIterable,
  noopFn,
  withTimeout,
} from '@nmtjs/common'
import { provision } from '@nmtjs/core'
import { GatewayInjectables, ProxyableTransportType } from '@nmtjs/gateway'
import { ErrorCode, ProtocolBlob } from '@nmtjs/protocol'
import {
  negotiateCodecs,
  ProtocolClientStream,
  ProtocolError,
  UnsupportedContentTypeError,
  CodecNegotiationError,
} from '@nmtjs/protocol/server'

import type { ServerHandler } from '../../http-server/transport.ts'
import type {
  HttpHandlerCorsCustomOptions,
  NeemataHttpHandlerOptions,
  NeemataHttpOptions,
  NeemataHttpRequest,
} from './types.ts'
import {
  AllowedHttpMethod,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  HttpCodeMap,
  HttpStatus,
  HttpStatusText,
} from './constants.ts'
import * as injections from './injectables.ts'
import { PayloadTooLargeError } from './utils.ts'

const NEEMATA_BLOB_HEADER = 'X-Neemata-Blob'
// Async-generator return() queues behind a stalled next(), so SSE cleanup
// must be cooperative without holding body cancellation open indefinitely.
const SSE_ITERATOR_CLEANUP_TIMEOUT = 10_000
const DEFAULT_ALLOWED_METHODS = Object.freeze(['post']) as ('get' | 'post')[]
// No allowCredentials here: reflecting arbitrary origins with credentials
// would let any website make cookie-authed requests
const DEFAULT_CORS_PARAMS = Object.freeze({
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Content-Type',
    'Content-Disposition',
    'Content-Length',
    'Accept',
    'Authorization',
    'Transfer-Encoding',
  ],
  maxAge: undefined,
  requestMethod: undefined,
  exposeHeaders: [],
  requestHeaders: [],
}) satisfies Omit<HttpHandlerCorsCustomOptions, 'origin'>
// Credentials are safe to allow when the user explicitly vetted the origin
const EXPLICIT_ORIGIN_CORS_PARAMS = Object.freeze({
  ...DEFAULT_CORS_PARAMS,
  allowCredentials: 'true',
}) satisfies Omit<HttpHandlerCorsCustomOptions, 'origin'>
const CORS_HEADERS_MAP: Record<
  keyof HttpHandlerCorsCustomOptions | 'origin',
  string
> = {
  origin: 'Access-Control-Allow-Origin',
  allowMethods: 'Access-Control-Allow-Methods',
  allowHeaders: 'Access-Control-Allow-Headers',
  allowCredentials: 'Access-Control-Allow-Credentials',
  maxAge: 'Access-Control-Max-Age',
  exposeHeaders: 'Access-Control-Expose-Headers',
  requestHeaders: 'Access-Control-Request-Headers',
  requestMethod: 'Access-Control-Request-Method',
}

export function neemataHttp({
  codecs,
}: NeemataHttpOptions): ServerHandler<
  NeemataHttpHandlerOptions,
  typeof injections,
  readonly [ProxyableTransportType.HTTP],
  NeemataHttpResolvedProcedure
> {
  return {
    proxyable: [ProxyableTransportType.HTTP],
    injectables: injections,
    mount({ host, gateway }, options) {
      // A handler cap above the host bound could never take effect (the
      // host rejects such bodies first) — fail loudly instead of letting
      // the config lie
      if (
        options.maxRequestBodySize !== undefined &&
        options.maxRequestBodySize > host.maxRequestBodySize
      ) {
        throw new Error(
          `HTTP handler maxRequestBodySize (${options.maxRequestBodySize}) ` +
            `exceeds the host limit (${host.maxRequestBodySize})`,
        )
      }
      const handler = new NeemataHttpHandler(
        gateway,
        codecs,
        options,
        host.maxRequestBodySize,
      )
      const unmount = host.mountFetchHandler({
        path: options.path,
        handler: handler.handle.bind(handler),
      })
      return { dispose: unmount }
    },
  }
}

export class NeemataHttpHandler {
  #corsOptions?: NeemataHttpHandlerOptions['cors']
  #maxRequestBodySize: number
  #codecs: ProtocolCodecRegistry

  constructor(
    readonly params: TransportWorkerParams<NeemataHttpResolvedProcedure>,
    codecs: ProtocolCodecRegistry,
    readonly options: NeemataHttpHandlerOptions,
    hostMaxRequestBodySize = DEFAULT_MAX_REQUEST_BODY_SIZE,
  ) {
    this.#corsOptions = options.cors
    this.#maxRequestBodySize =
      options.maxRequestBodySize ?? hostMaxRequestBodySize
    this.#codecs = codecs
  }

  async handle(request: NeemataHttpRequest): Promise<Response> {
    const url = new URL(request.url)
    const procedure = url.pathname.slice(
      this.options.path === '/' ? 1 : this.options.path.length + 1,
    )
    const method = request.method.toLowerCase()
    const origin = request.headers.get('origin')
    const responseHeaders = new Headers()
    // CORS makes responses origin-dependent (even denials), so shared caches
    // must key on Origin to avoid serving them across origins
    if (this.#corsOptions) responseHeaders.append('Vary', 'Origin')
    if (origin) this.applyCors(origin, request, responseHeaders)

    // Handle preflight requests
    if (method === 'options') {
      return new Response(null, {
        status: HttpStatus.OK,
        headers: responseHeaders,
      })
    }

    const controller = new AbortController()
    const signal = anyAbortSignal(request.signal, controller.signal)
    const canHaveBody = method !== 'get'
    const isBlob = request.headers.get(NEEMATA_BLOB_HEADER) === 'true'
    const contentType = request.headers.get('content-type')
    const accept = request.headers.get('accept') || '*/*'
    // GET endpoints are reachable via browser navigation, which sends HTML
    // Accept headers; fall back to the default codec only when the client's
    // Accept can't be negotiated
    const negotiableAccept =
      canHaveBody || this.#codecs.supportsEncoder(accept) ? accept : '*/*'

    // The handler owns codec negotiation (codecs are a projection
    // capability); the gateway sees only decoded runtime values. An
    // undecodable content-type is not an error: the body is passed through
    // as a raw blob stream payload, so only Accept can fail negotiation.
    const decodable =
      !isBlob && contentType !== null
        ? this.#codecs.supportsDecoder(contentType) !== null
        : false
    let encoder: BaseServerEncoder
    let decoder: BaseServerDecoder
    try {
      ;({ encoder, decoder } = negotiateCodecs(this.#codecs, {
        accept: negotiableAccept,
        contentType: decodable ? contentType : '*/*',
      }))
    } catch (error) {
      if (error instanceof CodecNegotiationError) {
        const status =
          error instanceof UnsupportedContentTypeError
            ? HttpStatus.UnsupportedMediaType
            : HttpStatus.NotAcceptable
        const text = HttpStatusText[status]
        return new Response(text, {
          status,
          statusText: text,
          headers: responseHeaders,
        })
      }
      throw error
    }

    // Streamed response bodies are consumed after handle() returns, so they
    // take ownership of connection teardown. Buffered and error paths retain
    // dispose-at-return behavior.
    let connection: Awaited<ReturnType<typeof this.params.onConnect>> | null =
      null
    let streamed = false
    let disposal: Promise<void> | null = null
    const disposeConnection = () => {
      if (!connection) return Promise.resolve()
      return (disposal ??= Promise.resolve(connection[Symbol.asyncDispose]()))
    }

    try {
      connection = await this.params.onConnect({ data: request })
      const resolved = await this.params.resolve(connection, procedure)

      const allowHttpMethod =
        resolved.meta.get(AllowedHttpMethod) ?? DEFAULT_ALLOWED_METHODS

      if (!allowHttpMethod.includes(method as any)) {
        throw new ProtocolError(ErrorCode.NotFound)
      }

      let payload: any

      if (canHaveBody && request.body) {
        const cannotDecode =
          !contentType || !this.#codecs.supportsDecoder(contentType)
        if (isBlob || cannotDecode) {
          const type = contentType || 'application/octet-stream'
          const contentLength = request.headers.get('content-length')
          const size = contentLength
            ? Number.parseInt(contentLength, 10)
            : undefined
          // Declared size over the cap: reject before reading anything
          if (size !== undefined && size > this.#maxRequestBodySize) {
            throw new PayloadTooLargeError()
          }
          const clientStream = new ProtocolClientStream(-1, { size, type })
          // The rpc may never read the payload; without a handler a capped
          // upload would crash the process with an unhandled 'error'
          clientStream.on('error', () => {})
          payload = clientStream
          // pipeline (unlike pipe) propagates source errors; the cap error is
          // re-surfaced on the payload stream so its consumer rejects with it
          pipeline(
            Readable.fromWeb(request.body as any),
            this.createBodySizeGuard(),
            clientStream,
          ).catch((error) => clientStream.destroy(error))
        } else {
          const chunks: Buffer[] = []
          let received = 0
          for await (const chunk of Readable.fromWeb(request.body as any)) {
            received += chunk.byteLength
            // Reject mid-stream to avoid buffering unbounded payloads
            if (received > this.#maxRequestBodySize) {
              throw new PayloadTooLargeError()
            }
            chunks.push(chunk)
          }
          const buffer = Buffer.concat(chunks)
          if (buffer.byteLength > 0) {
            payload = decoder.decode(buffer)
          }
        }
      } else {
        const querystring = url.searchParams.get('payload')
        if (querystring) {
          try {
            payload = JSON.parse(querystring)
          } catch {
            throw new ProtocolError(ErrorCode.BadRequest, 'Invalid payload')
          }
        }
      }

      const result = await this.params.onRpc(
        connection,
        { payload, procedure },
        signal,
        provision(injections.httpResponseHeaders, responseHeaders),
        // Blob capabilities are projection-owned: HTTP represents a server
        // blob as the response body, so createBlob is a plain wrapper and
        // consumeBlob has nothing to look up (the request body already
        // arrives as a stream payload)
        provision(GatewayInjectables.createBlob, (source, metadata) =>
          ProtocolBlob.from(source, metadata),
        ),
        provision(GatewayInjectables.consumeBlob, () => {
          throw new Error('Stream not found')
        }),
      )

      if (result instanceof Response) {
        const { status, statusText, headers, body } = result
        headers.forEach((value, key) => {
          // Merge Vary so the cors Origin entry isn't lost to shared caches
          if (key.toLowerCase() === 'vary') responseHeaders.append(key, value)
          else responseHeaders.set(key, value)
        })

        const streamedBody =
          body !== null && headers.get('content-length') !== '0'
        const finalizedBody = streamedBody
          ? this.finalizeOnBodyEnd(body, signal, disposeConnection)
          : body
        streamed = streamedBody

        return new Response(finalizedBody, {
          status,
          statusText,
          headers: responseHeaders,
        })
      } else if (result instanceof ProtocolBlob) {
        const { source, metadata } = result
        const { type } = metadata

        responseHeaders.set(NEEMATA_BLOB_HEADER, 'true')
        responseHeaders.set('Content-Type', type)
        // nullish check — zero is a valid size for empty blobs
        if (metadata.size !== undefined) {
          responseHeaders.set('Content-Length', metadata.size.toString())
        }
        if (metadata.filename) {
          responseHeaders.set(
            'Content-Disposition',
            `attachment; filename="${metadata.filename}"`,
          )
        }

        // Convert source to ReadableStream
        let stream: ReadableStream

        if (source instanceof ReadableStream) {
          stream = source
        } else if (source instanceof Readable || source instanceof Duplex) {
          stream = Readable.toWeb(source) as unknown as ReadableStream
        } else {
          throw new Error('Invalid stream source')
        }

        const finalizedBody =
          metadata.size !== 0
            ? this.finalizeOnBodyEnd(stream, signal, disposeConnection)
            : stream
        streamed = metadata.size !== 0

        return new Response(finalizedBody, {
          status: HttpStatus.OK,
          statusText: HttpStatusText[HttpStatus.OK],
          headers: responseHeaders,
        })
      } else if (isAsyncIterable(result)) {
        responseHeaders.set('Content-Type', 'text/event-stream')
        responseHeaders.set('Cache-Control', 'no-cache, no-transform')
        responseHeaders.set('X-Stream-Content-Type', encoder.contentType)
        responseHeaders.set('X-Accel-Buffering', 'no')
        const iterator = result[Symbol.asyncIterator]()
        const sse = new TextEncoder()
        const cleanupIterator = async () => {
          try {
            await withTimeout(
              Promise.resolve(iterator.return?.()),
              SSE_ITERATOR_CLEANUP_TIMEOUT,
              new Error('SSE iterator cleanup timed out'),
            )
          } catch {}
        }
        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await iterator.next()
              if (done) {
                controller.close()
                return
              }
              const encoded = encoder.encode(value)
              const base64 = Buffer.from(
                encoded.buffer,
                encoded.byteOffset,
                encoded.byteLength,
              ).toString('base64')
              controller.enqueue(sse.encode(`data: ${base64}\n\n`))
            } catch (error) {
              await cleanupIterator()
              if (isAbortError(error)) controller.close()
              else controller.error(error)
            }
          },
          async cancel() {
            await cleanupIterator()
          },
        })
        const finalizedBody = this.finalizeOnBodyEnd(
          stream,
          signal,
          disposeConnection,
        )
        streamed = true

        return new Response(finalizedBody, {
          status: HttpStatus.OK,
          statusText: HttpStatusText[HttpStatus.OK],
          headers: responseHeaders,
        })
      } else {
        // Handle regular responses
        // void results respond with an empty body — encode rejects undefined
        const buffer =
          typeof result === 'undefined' ? undefined : encoder.encode(result)
        responseHeaders.set('Content-Type', encoder.contentType)

        // @ts-expect-error
        return new Response(buffer, {
          status: HttpStatus.OK,
          statusText: HttpStatusText[HttpStatus.OK],
          headers: responseHeaders,
        })
      }
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        const status = HttpStatus.PayloadTooLarge
        const text = HttpStatusText[status]

        return new Response(text, {
          status,
          statusText: text,
          headers: responseHeaders,
        })
      }

      if (error instanceof CodecNegotiationError) {
        const status =
          error instanceof UnsupportedContentTypeError
            ? HttpStatus.UnsupportedMediaType
            : HttpStatus.NotAcceptable
        const text = HttpStatusText[status]

        return new Response(text, {
          status,
          statusText: text,
          headers: responseHeaders,
        })
      }

      if (error instanceof ProtocolError) {
        const status =
          error.code in HttpCodeMap
            ? HttpCodeMap[error.code]
            : HttpStatus.InternalServerError
        const text = HttpStatusText[status]
        const payload = encoder.encode(error)
        responseHeaders.set('Content-Type', encoder.contentType)

        // @ts-expect-error
        return new Response(payload, {
          status,
          statusText: text,
          headers: responseHeaders,
        })
      }

      // Unknown error
      // this.logError(error, 'Unknown error while processing HTTP request')
      console.error(error)

      const payload = encoder.encode(
        new ProtocolError(
          ErrorCode.InternalServerError,
          'Internal Server Error',
        ),
      )
      responseHeaders.set('Content-Type', encoder.contentType)

      // @ts-expect-error
      return new Response(payload, {
        status: HttpStatus.InternalServerError,
        statusText: HttpStatusText[HttpStatus.InternalServerError],
        headers: responseHeaders,
      })
    } finally {
      if (!streamed) await disposeConnection()
    }
  }

  private finalizeOnBodyEnd(
    body: ReadableStream,
    signal: AbortSignal,
    finalize: () => Promise<void>,
  ): ReadableStream {
    const reader = body.getReader()
    const settle = () => {
      signal.removeEventListener('abort', onAbort)
      return finalize()
    }
    const onAbort = () => {
      // Closing the connection first aborts call signals, which gives
      // cooperative sources a chance to leave a pending read.
      settle().catch(noopFn)
      reader.cancel(signal.reason).catch(noopFn)
    }

    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    return new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            await settle()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          await settle()
          controller.error(error)
        }
      },
      async cancel(reason) {
        const finalized = settle()
        await reader.cancel(reason).catch(noopFn)
        await finalized
      },
    })
  }

  private createBodySizeGuard() {
    const maxSize = this.#maxRequestBodySize
    let received = 0
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength
        // Enforce the cap even when the declared content-length lies
        if (received > maxSize) callback(new PayloadTooLargeError())
        else callback(null, chunk)
      },
    })
  }

  private applyCors(
    origin: string,
    request: NeemataHttpRequest,
    headers: Headers,
  ) {
    if (!this.#corsOptions) return

    let params: Omit<HttpHandlerCorsCustomOptions, 'origin'> | null = null

    if (this.#corsOptions === true) {
      params = { ...DEFAULT_CORS_PARAMS }
    } else if (Array.isArray(this.#corsOptions)) {
      if (this.#corsOptions.includes(origin)) {
        params = { ...EXPLICIT_ORIGIN_CORS_PARAMS }
      }
    } else if (typeof this.#corsOptions === 'object') {
      if (
        this.#corsOptions.origin === true ||
        this.#corsOptions.origin.includes(origin)
      ) {
        params =
          this.#corsOptions.origin === true
            ? { ...DEFAULT_CORS_PARAMS }
            : { ...EXPLICIT_ORIGIN_CORS_PARAMS }
        for (const key in params) {
          const value = this.#corsOptions[key]
          if (value !== undefined) {
            params[key] = value
          }
        }
        // This explicit opt-in restores credentialed origin reflection without
        // weakening the safe `cors: true` default.
        if (this.#corsOptions.allowCredentials !== undefined) {
          params.allowCredentials = this.#corsOptions.allowCredentials
        }
      }
    } else if (typeof this.#corsOptions === 'function') {
      const result = this.#corsOptions(origin, request)
      if (typeof result === 'boolean') {
        if (result) {
          params = { ...EXPLICIT_ORIGIN_CORS_PARAMS }
        }
      } else if (typeof result === 'object') {
        // Returned params must still match the requesting origin, otherwise
        // any origin would get reflected (with credentials for allowlists)
        if (result.origin === true || result.origin.includes(origin)) {
          params =
            result.origin === true
              ? { ...DEFAULT_CORS_PARAMS }
              : { ...EXPLICIT_ORIGIN_CORS_PARAMS }
          for (const key in params) {
            const value = result[key]
            if (value !== undefined) {
              params[key] = value
            }
          }
          if (result.allowCredentials !== undefined) {
            params.allowCredentials = result.allowCredentials
          }
        }
      }
    }

    if (params === null) return

    headers.set(CORS_HEADERS_MAP.origin, origin)

    for (const key in params) {
      const header = CORS_HEADERS_MAP[key]
      if (header) {
        let value = params[key]
        if (Array.isArray(value)) value = value.filter(Boolean).join(', ')
        if (value) headers.set(header, value)
      }
    }
  }
}

export interface NeemataHttpResolvedProcedure extends GatewayResolvedProcedure {
  readonly meta: Pick<GatewayStaticMetaView, 'get'>
}
