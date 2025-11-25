import { Buffer } from 'node:buffer'
import { Duplex, Readable } from 'node:stream'

import type {
  GatewayApiCallOptions,
  TransportV2Worker,
  TransportV2WorkerParams,
} from '@nmtjs/gateway'
import type { Peer } from 'crossws'
import { isAsyncIterable } from '@nmtjs/common'
import { provide } from '@nmtjs/core'
import {
  ConnectionType,
  ErrorCode,
  ProtocolBlob,
  ProtocolVersion,
} from '@nmtjs/protocol'
import {
  ProtocolClientStream,
  ProtocolError,
  UnsupportedContentTypeError,
  UnsupportedFormatError,
} from '@nmtjs/protocol/server'

import type {
  HttpAdapterParams,
  HttpAdapterServer,
  HttpAdapterServerFactory,
  HttpTransportCorsCustomParams,
  HttpTransportCorsOptions,
  HttpTransportOptions,
  HttpTransportServerRequest,
} from './types.ts'
import {
  AllowedHttpMethod,
  HttpCodeMap,
  HttpStatus,
  HttpStatusText,
} from './constants.ts'
import * as injections from './injectables.ts'

const NEEMATA_BLOB_HEADER = 'X-Neemata-Blob'
const DEFAULT_ALLOWED_METHODS = Object.freeze(['post']) as ('get' | 'post')[]
const DEFAULT_CORS_PARAMS = Object.freeze({
  allowCredentials: 'true',
  allowMethods: ['GET', 'POST'],
  allowHeaders: ['Content-Type', 'Accept'],
  maxAge: undefined,
  requestMethod: undefined,
  exposeHeaders: [],
  requestHeaders: [],
}) satisfies HttpTransportCorsCustomParams
const CORS_HEADERS_MAP: Record<
  keyof HttpTransportCorsCustomParams | 'origin',
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

export function createHTTPTransportWorker(
  adapterFactory: HttpAdapterServerFactory<any>,
  options: HttpTransportOptions,
): TransportV2Worker<ConnectionType.Unidirectional> {
  return new HttpTransportServer(adapterFactory, options)
}

export class HttpTransportServer
  implements TransportV2Worker<ConnectionType.Unidirectional>
{
  #server: HttpAdapterServer
  #corsOptions?:
    | null
    | true
    | string[]
    | HttpTransportCorsOptions
    | ((origin: string) => boolean | HttpTransportCorsOptions)

  params!: TransportV2WorkerParams<ConnectionType.Unidirectional>
  clients = new Map<string, Peer>()

  constructor(
    protected readonly adapterFactory: HttpAdapterServerFactory<any>,
    protected readonly options: HttpTransportOptions,
  ) {
    this.#server = this.createServer()
    this.#corsOptions = this.options.cors
  }

  async start(hooks: TransportV2WorkerParams<ConnectionType.Unidirectional>) {
    this.params = hooks
    return await this.#server.start()
  }

  async stop() {
    await this.#server.stop()
  }

  // send(
  //   connection: Connection<WsConnectionData>,
  //   messageType: ServerMessageType,
  //   buffer: ArrayBuffer,
  // ) {
  //   const peer = this.clients.get(connection.id)
  //   peer?.send(concat(encodeNumber(messageType, 'Uint8'), buffer))
  // }

  async httpHandler(
    request: HttpTransportServerRequest,
    body: ReadableStream | null,
    requestSignal: AbortSignal,
  ): Promise<Response> {
    const url = new URL(request.url)
    const procedure = url.pathname.slice(1) // remove leading '/'
    const method = request.method.toLowerCase()
    const origin = request.headers.get('origin')
    const responseHeaders = new Headers()
    if (origin) this.applyCors(origin, request, responseHeaders)

    // Handle preflight requests
    if (method === 'options') {
      return new Response(null, {
        status: HttpStatus.OK,
        headers: responseHeaders,
      })
    }

    const controller = new AbortController()
    const signal = AbortSignal.any([requestSignal, controller.signal])
    const canHaveBody = method !== 'get'
    const isBlob = request.headers.get(NEEMATA_BLOB_HEADER) === 'true'
    const contentType = request.headers.get('content-type')
    const accept = request.headers.get('accept') || '*/*'

    await using connection = await this.params.onConnect({
      accept,
      contentType: isBlob ? '*/*' : contentType,
      data: request,
      protocolVersion: ProtocolVersion.v1,
      type: ConnectionType.Unidirectional,
    })

    try {
      // Parse request body if present
      let payload: any
      if (canHaveBody && body) {
        const bodyStream = Readable.fromWeb(body as any)
        const cannotDecode =
          !contentType || !this.params.formats.supportsDecoder(contentType)
        if (isBlob || cannotDecode) {
          const type = contentType || 'application/octet-stream'
          const contentLength = request.headers.get('content-length')
          const size = contentLength
            ? Number.parseInt(contentLength)
            : undefined
          payload = new ProtocolClientStream(-1, { size, type })
          bodyStream.pipe(payload)
        } else {
          const buffer = Buffer.concat(await bodyStream.toArray())
          if (buffer.byteLength > 0) {
            payload = connection.decoder.decode(buffer)
          }
        }
      }

      const metadata: GatewayApiCallOptions['metadata'] = (metadata) => {
        const allowHttpMethod =
          metadata.get(AllowedHttpMethod) ?? DEFAULT_ALLOWED_METHODS
        if (!allowHttpMethod.includes(method as any)) {
          throw new ProtocolError(ErrorCode.NotFound)
        }
      }

      const result = await this.params.onRpc(
        connection,
        {
          callId: 0, // since the connection is closed after the call, only one call exists per connection
          payload,
          procedure,
          metadata,
        },
        signal,
        provide(injections.httpResponseHeaders, responseHeaders),
      )

      // Handle blob responses
      if (result instanceof ProtocolBlob) {
        const { source, metadata } = result
        const { type } = metadata

        responseHeaders.set(NEEMATA_BLOB_HEADER, 'true')
        responseHeaders.set('Content-Type', type)
        if (metadata.size) {
          responseHeaders.set('Content-Length', metadata.size.toString())
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

        return new Response(stream, {
          status: HttpStatus.OK,
          statusText: HttpStatusText[HttpStatus.OK],
          headers: responseHeaders,
        })
      } else if (isAsyncIterable(result)) {
        // TODO: implement iterable responses over SSE
        // Handle streaming results
        controller.abort('Transport does not support streaming results')
        // TODO: might be better to fail early by checking procedure's contract
        // whether it supports streaming without actually calling it
        return new Response('Not Implemented', {
          status: HttpStatus.NotImplemented,
          statusText: HttpStatusText[HttpStatus.NotImplemented],
          headers: responseHeaders,
        })
      }

      // Handle regular responses
      const buffer = connection.encoder.encode(result)
      responseHeaders.set('Content-Type', connection.encoder.contentType)

      // @ts-expect-error
      return new Response(buffer, {
        status: HttpStatus.OK,
        statusText: HttpStatusText[HttpStatus.OK],
        headers: responseHeaders,
      })
    } catch (error) {
      if (error instanceof UnsupportedFormatError) {
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
        const payload = connection.encoder.encode(error)
        responseHeaders.set('Content-Type', connection.encoder.contentType)

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

      const payload = connection.encoder.encode(
        new ProtocolError(
          ErrorCode.InternalServerError,
          'Internal Server Error',
        ),
      )
      responseHeaders.set('Content-Type', connection.encoder.contentType)

      // @ts-expect-error
      return new Response(payload, {
        status: HttpStatus.InternalServerError,
        statusText: HttpStatusText[HttpStatus.InternalServerError],
        headers: responseHeaders,
      })
    }
  }

  private applyCors(
    origin: string,
    request: HttpTransportServerRequest,
    headers: Headers,
  ) {
    if (!this.#corsOptions) return

    let params: HttpTransportCorsCustomParams | null = null

    if (this.options.cors === true) {
      params = { ...DEFAULT_CORS_PARAMS }
    } else if (
      Array.isArray(this.options.cors) &&
      this.options.cors.includes(origin)
    ) {
      params = { ...DEFAULT_CORS_PARAMS }
    } else if (typeof this.options.cors === 'function') {
      const result = this.options.cors(origin, request)
      if (typeof result === 'boolean') {
        if (result) {
          params = { ...DEFAULT_CORS_PARAMS }
        }
      } else if (typeof result === 'object') {
        params = { ...DEFAULT_CORS_PARAMS }
        for (const key in DEFAULT_CORS_PARAMS) {
          params[key] = result[key]
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

  private createServer() {
    // const hooks = this.createWsHooks()
    const opts: HttpAdapterParams = {
      ...this.options,
      // logger: this.logger.child({ $lable: 'WsServer' }),
      fetchHandler: this.httpHandler.bind(this),
    }
    return this.adapterFactory(opts)
  }
}
