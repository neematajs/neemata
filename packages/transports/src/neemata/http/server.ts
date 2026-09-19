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
import { isAbortError, isAsyncIterable } from '@nmtjs/common'
import { provision } from '@nmtjs/core'
import { GatewayInjectables, ProxyableTransportType } from '@nmtjs/gateway'
import { BLOB_HEADER, ErrorCode, ProtocolBlob } from '@nmtjs/protocol'
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
  assertBodyLimit,
  PayloadTooLargeError,
  readCappedBody,
} from '../../http-server/utils.ts'
import {
  AllowedHttpMethod,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  HttpStatus,
  HttpStatusText,
  ProtocolToHttpStatus,
} from './constants.ts'
import * as injections from './injectables.ts'

const DEFAULT_ALLOWED_METHODS: readonly string[] = Object.freeze(['post'])

type CorsParams = Omit<HttpHandlerCorsCustomOptions, 'origin'>

/**
 * Response header per policy field. `origin` is written separately: the
 * response always reflects the requesting origin, never the configured value.
 */
const CORS_HEADERS: Record<keyof CorsParams, string> = {
  allowMethods: 'Access-Control-Allow-Methods',
  allowHeaders: 'Access-Control-Allow-Headers',
  allowCredentials: 'Access-Control-Allow-Credentials',
  maxAge: 'Access-Control-Max-Age',
  exposeHeaders: 'Access-Control-Expose-Headers',
  requestHeaders: 'Access-Control-Request-Headers',
  requestMethod: 'Access-Control-Request-Method',
}
const CORS_FIELDS = Object.keys(CORS_HEADERS) as (keyof CorsParams)[]

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
  exposeHeaders: [],
  requestHeaders: [],
}) satisfies CorsParams
// Credentials are safe to allow when the user explicitly vetted the origin
const EXPLICIT_ORIGIN_CORS_PARAMS = Object.freeze({
  ...DEFAULT_CORS_PARAMS,
  allowCredentials: 'true',
}) satisfies CorsParams

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
      assertBodyLimit(
        'HTTP',
        options.maxRequestBodySize,
        host.maxRequestBodySize,
      )
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
    const headers = new Headers()
    // CORS makes responses origin-dependent (even denials), so shared caches
    // must key on Origin to avoid serving them across origins
    if (this.#corsOptions) headers.append('Vary', 'Origin')
    if (origin) this.applyCors(origin, request, headers)

    // Handle preflight requests
    if (method === 'options') {
      return new Response(null, { status: HttpStatus.OK, headers })
    }

    const canHaveBody = method !== 'get'
    const contentType = request.headers.get('content-type')
    // The handler owns codec negotiation (codecs are a projection
    // capability); the gateway sees only decoded runtime values. An
    // undecodable content-type is not an error: the body is passed through
    // as a raw blob stream payload, so only Accept can fail negotiation.
    const rawBody =
      request.headers.get(BLOB_HEADER) === 'true' ||
      !contentType ||
      !this.#codecs.supportsDecoder(contentType)

    let encoder: BaseServerEncoder
    let decoder: BaseServerDecoder
    try {
      ;({ encoder, decoder } = this.negotiate(
        request,
        canHaveBody,
        rawBody ? '*/*' : contentType,
      ))
    } catch (error) {
      if (error instanceof CodecNegotiationError) {
        const status =
          error instanceof UnsupportedContentTypeError
            ? HttpStatus.UnsupportedMediaType
            : HttpStatus.NotAcceptable
        return statusResponse(status, headers)
      }
      throw error
    }

    await using connection = await this.params.onConnect({ data: request })

    try {
      const resolved = await this.params.resolve(connection, procedure)

      const allowedMethods: readonly string[] =
        resolved.meta.get(AllowedHttpMethod) ?? DEFAULT_ALLOWED_METHODS
      if (!allowedMethods.includes(method)) {
        throw new ProtocolError(ErrorCode.NotFound)
      }

      let payload: unknown
      if (canHaveBody && request.body) {
        payload = rawBody
          ? this.streamBody(request)
          : await this.decodeBody(request.body, decoder)
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
        request.signal,
        provision(injections.httpResponseHeaders, headers),
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

      return this.toResponse(result, encoder, headers)
    } catch (error) {
      return this.toErrorResponse(error, encoder, headers)
    }
  }

  /**
   * GET endpoints are reachable via browser navigation, which sends HTML
   * Accept headers; fall back to the default codec only when the client's
   * Accept can't be negotiated.
   */
  private negotiate(
    request: NeemataHttpRequest,
    canHaveBody: boolean,
    contentType: string | null,
  ) {
    const accept = request.headers.get('accept') || '*/*'
    const negotiable =
      canHaveBody || this.#codecs.supportsEncoder(accept) ? accept : '*/*'
    return negotiateCodecs(this.#codecs, { accept: negotiable, contentType })
  }

  /** Blob and undecodable bodies reach the rpc as a capped stream payload. */
  private streamBody(request: NeemataHttpRequest) {
    const type =
      request.headers.get('content-type') || 'application/octet-stream'
    const contentLength = request.headers.get('content-length')
    const size = contentLength ? Number.parseInt(contentLength, 10) : undefined
    // Declared size over the cap: reject before reading anything
    if (size !== undefined && size > this.#maxRequestBodySize) {
      throw new PayloadTooLargeError()
    }
    const stream = new ProtocolClientStream(-1, { size, type })
    // The rpc may never read the payload; without a handler a capped
    // upload would crash the process with an unhandled 'error'
    stream.on('error', () => {})
    // pipeline (unlike pipe) propagates source errors; the cap error is
    // re-surfaced on the payload stream so its consumer rejects with it
    pipeline(
      Readable.fromWeb(request.body as any),
      this.createBodySizeGuard(),
      stream,
    ).catch((error) => stream.destroy(error))
    return stream
  }

  private async decodeBody(
    body: ReadableStream<Uint8Array>,
    decoder: BaseServerDecoder,
  ): Promise<unknown> {
    const buffer = await readCappedBody(body, this.#maxRequestBodySize)
    // an empty body stays an absent payload — decode rejects zero bytes
    if (buffer.byteLength === 0) return undefined
    return decoder.decode(buffer)
  }

  private toResponse(
    result: unknown,
    encoder: BaseServerEncoder,
    headers: Headers,
  ): Response {
    if (result instanceof Response) {
      const { status, statusText, body } = result
      result.headers.forEach((value, key) => {
        // Merge Vary so the cors Origin entry isn't lost to shared caches
        if (key.toLowerCase() === 'vary') headers.append(key, value)
        else headers.set(key, value)
      })
      return new Response(body, { status, statusText, headers })
    }

    if (result instanceof ProtocolBlob) {
      const { source, metadata } = result

      headers.set(BLOB_HEADER, 'true')
      headers.set('Content-Type', metadata.type)
      // nullish check — zero is a valid size for empty blobs
      if (metadata.size !== undefined) {
        headers.set('Content-Length', metadata.size.toString())
      }
      if (metadata.filename) {
        headers.set(
          'Content-Disposition',
          `attachment; filename="${metadata.filename}"`,
        )
      }

      let stream: ReadableStream
      if (source instanceof ReadableStream) {
        stream = source
      } else if (source instanceof Readable || source instanceof Duplex) {
        stream = Readable.toWeb(source) as unknown as ReadableStream
      } else {
        throw new Error('Invalid stream source')
      }

      return new Response(stream, {
        status: HttpStatus.OK,
        statusText: HttpStatusText[HttpStatus.OK],
        headers,
      })
    }

    if (isAsyncIterable(result)) {
      headers.set('Content-Type', 'text/event-stream')
      headers.set('Cache-Control', 'no-cache, no-transform')
      headers.set('X-Stream-Content-Type', encoder.contentType)
      headers.set('X-Accel-Buffering', 'no')
      const stream = new ReadableStream({
        async start(controller) {
          const sse = new TextEncoder()
          try {
            for await (const chunk of result) {
              const encoded = encoder.encode(chunk)
              const base64 = Buffer.from(
                encoded.buffer,
                encoded.byteOffset,
                encoded.byteLength,
              ).toString('base64')
              controller.enqueue(sse.encode(`data: ${base64}\n\n`))
            }
            controller.close()
          } catch (error) {
            if (isAbortError(error)) controller.close()
            else controller.error(error)
          }
        },
      })
      return new Response(stream, {
        status: HttpStatus.OK,
        statusText: HttpStatusText[HttpStatus.OK],
        headers,
      })
    }

    // void results respond with an empty body — encode rejects undefined
    const encoded = result === undefined ? undefined : encoder.encode(result)
    headers.set('Content-Type', encoder.contentType)
    return encodedResponse(encoded, HttpStatus.OK, headers)
  }

  private toErrorResponse(
    error: unknown,
    encoder: BaseServerEncoder,
    headers: Headers,
  ): Response {
    // CodecNegotiationError cannot surface here: negotiateCodecs runs before
    // the dispatch this catches, and nothing below it negotiates again
    if (error instanceof PayloadTooLargeError) {
      return statusResponse(HttpStatus.PayloadTooLarge, headers)
    }

    let status: HttpStatus
    let body: ProtocolError
    if (error instanceof ProtocolError) {
      status =
        ProtocolToHttpStatus[error.code] ?? HttpStatus.InternalServerError
      body = error
    } else {
      console.error(error)
      status = HttpStatus.InternalServerError
      body = new ProtocolError(
        ErrorCode.InternalServerError,
        'Internal Server Error',
      )
    }

    headers.set('Content-Type', encoder.contentType)
    return encodedResponse(encoder.encode(body), status, headers)
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
    const params = this.resolveCors(origin, request)
    if (!params) return

    headers.set('Access-Control-Allow-Origin', origin)
    for (const field of CORS_FIELDS) {
      const value = params[field]
      const header = Array.isArray(value)
        ? value.filter(Boolean).join(', ')
        : value
      if (header) headers.set(CORS_HEADERS[field], header)
    }
  }

  /** The policy for this origin, or null when CORS must stay off for it. */
  private resolveCors(
    origin: string,
    request: NeemataHttpRequest,
  ): CorsParams | null {
    const options = this.#corsOptions
    if (!options) return null
    if (options === true) return DEFAULT_CORS_PARAMS
    if (Array.isArray(options)) {
      return options.includes(origin) ? EXPLICIT_ORIGIN_CORS_PARAMS : null
    }

    const policy =
      typeof options === 'function'
        ? options.call(this, origin, request)
        : options
    // A callback returning true has vetted this origin; cors: true has not.
    if (policy === true) return EXPLICIT_ORIGIN_CORS_PARAMS
    if (typeof policy !== 'object') return null

    // Callback policies must still match the requesting origin.
    const allowed = policy.origin
    if (allowed !== true && !allowed.includes(origin)) return null

    // An explicit allowCredentials restores credentialed origin reflection
    // without weakening the safe `cors: true` default.
    const params: CorsParams = {
      ...(allowed === true ? DEFAULT_CORS_PARAMS : EXPLICIT_ORIGIN_CORS_PARAMS),
    }
    for (const field of CORS_FIELDS) {
      const value = policy[field]
      if (value !== undefined) Object.assign(params, { [field]: value })
    }
    return params
  }
}

/** Status-only response whose body is its own reason phrase. */
function statusResponse(status: HttpStatus, headers: Headers): Response {
  const text = HttpStatusText[status]
  return new Response(text, { status, statusText: text, headers })
}

/**
 * Codec output as a response body. Holds the single cast: codecs return a
 * plain `ArrayBufferView`, which the DOM `BodyInit` union does not accept.
 */
function encodedResponse(
  body: ArrayBufferView | undefined,
  status: HttpStatus,
  headers: Headers,
): Response {
  return new Response(body as BodyInit | undefined, {
    status,
    statusText: HttpStatusText[status],
    headers,
  })
}

export interface NeemataHttpResolvedProcedure extends GatewayResolvedProcedure {
  readonly meta: Pick<GatewayStaticMetaView, 'get'>
}
