import {
  type AnyProcedure,
  type Container,
  EncodedStreamResponse,
  type Procedure,
  Scope,
  StreamResponse,
} from '@neematajs/application'
import { Server } from '@neematajs/bun-http-server'
import { ApiError, type BaseServerFormat, ErrorCode } from '@neematajs/common'
import qs from 'qs'
import { HttpConnection } from './connection'
import {
  HttpStatusMessage,
  HttpTransportMethod,
  HttpTransportMethodOption,
} from './constants'
import type { HttpTransport } from './transport'
import { type ParsedRequest, getBody, getFormat, getRequest } from './utils'

export class HttpTransportServer {
  protected server!: Server<any>

  constructor(protected readonly transport: HttpTransport) {
    this.server = new Server(
      {
        port: this.options.port,
        hostname: this.options.hostname,
        tls: this.options.tls,
        development: false,
      },
      {
        cors: this.options.cors ?? {
          origin: '*',
          methods: ['GET', 'POST', 'OPTIONS'],
          headers: ['Content-Type', 'Authorization'],
          credentials: 'true',
        },
      },
    )
      .get('/healthy', () => new Response('OK'))
      .request(['GET', 'POST'], '/api/**/*', async (req, server) => {
        const format = getFormat(req, this.application.format)
        const request = getRequest(req, server)
        const headers = new Headers()
        if (format instanceof Response) return format

        headers.set('Content-Type', format.encoder.mime)

        try {
          const name = request.path.slice(5) // remove "/api/"
          const procedure = this.api.find(name, this.transport)
          const payload = await this.getPayload(request, format.decoder)
          return await this.handleHttpRequest({
            // @ts-expect-error Bun types conflicting with Node types
            headers,
            request,
            procedure,
            payload,
            format: format.encoder,
          })
        } catch (cause) {
          if (cause instanceof ApiError) {
            return new Response(format.encoder.encode(cause))
          } else {
            if (cause instanceof Error) this.logError(cause)
            const error = new ApiError(ErrorCode.InternalServerError)
            return new Response(format.encoder.encode(error))
          }
        }
      })
  }

  get options() {
    return this.transport.options
  }

  get application() {
    return this.transport.application
  }

  get api() {
    return this.transport.application.api
  }

  get logger() {
    return this.transport.application.logger
  }

  get format() {
    return this.transport.application.format
  }

  async start() {
    const url = this.server.listen()
    this.logger.info('Server started on %s', url)
  }

  async stop() {
    this.server.close()
  }

  protected async logError(
    cause: Error,
    message = 'Unknown error while processing request',
  ) {
    this.logger.error(message ? new Error(message, { cause }) : cause)
  }

  protected handleContainerDisposal(container: Container) {
    container
      .dispose()
      .catch((cause) =>
        this.logError(
          cause,
          'Container disposal error (potential memory leak)',
        ),
      )
  }

  protected async handleRPC(options: {
    container: Container
    procedure: AnyProcedure
    payload: any
    connection: HttpConnection
  }) {
    return await this.api.call({
      ...options,
      transport: this.transport,
    })
  }

  protected async handleHttpRequest(options: {
    request: ParsedRequest
    procedure: Procedure
    headers: Headers
    payload: any
    format: BaseServerFormat
  }) {
    const { procedure, request, payload, headers, format } = options

    const allowedMethods = procedure.options[HttpTransportMethodOption] ?? [
      HttpTransportMethod.Post,
    ]

    if (!allowedMethods.includes(request.method.toLocaleLowerCase())) {
      throw new ApiError(ErrorCode.NotFound)
    }

    const connection = new HttpConnection(
      this.application.registry,
      {
        headers: Object.fromEntries(request.req.headers),
        query: request.query,
        method: request.method as HttpTransportMethod,
        ip: request.ip,
        transport: 'http',
      },
      headers,
    )
    const container = this.application.container.createScope(Scope.Call)
    try {
      const result = await this.handleRPC({
        container,
        procedure,
        payload,
        connection,
      })
      if (result instanceof Blob) {
        if (request.method !== 'GET') {
          this.logger.error('Blob is only supported for GET requests')
          throw new ApiError(ErrorCode.InternalServerError)
        }
        this.handleContainerDisposal(container)
        return new Response(result, {
          status: 200,
          headers,
        })
      } else if (result instanceof StreamResponse) {
        if (
          request.method === 'GET' &&
          result instanceof EncodedStreamResponse
        ) {
          this.logger.error(
            'Encoded stream is only supported for POST requests',
          )
          throw new ApiError(ErrorCode.InternalServerError)
        }
        result.once('end', () => this.handleContainerDisposal(container))
        return new Response(result, { status: 200, headers })
      } else {
        this.handleContainerDisposal(container)
        return new Response(format.encode(result), {
          status: 200,
          headers,
        })
      }
    } catch (cause: any) {
      this.handleContainerDisposal(container)

      if (cause instanceof ApiError) return new Response(format.encode(cause))
      this.logError(cause)
      const error = new ApiError(ErrorCode.InternalServerError)
      return new Response(format.encode(error))
    }
  }

  protected async getPayload(request: ParsedRequest, format: BaseServerFormat) {
    if (request.method === 'GET') {
      return qs.parse(request.queryString)
    } else {
      const body = await getBody(request.req).asArrayBuffer()
      return format.decode(body)
    }
  }
  private applyCors(req: Request, headers: Headers) {
    const origin = req.headers.get('origin')

    if (this.options.cors && origin) {
      const { cors } = this.options
      let allowed = false
      if (typeof cors.origin === 'string')
        allowed = cors.origin === req.headers.get('origin')
      else if (cors.origin instanceof Bun.Glob) {
        allowed = cors.origin.match(origin)
      } else {
        allowed = cors.origin(req)
      }

      if (allowed) {
        headers.set('access-control-allow-origin', origin)
        for (const type of ['methods', 'headers', 'credentials'] as const) {
          if (cors[type]) {
            headers.set(`Access-Control-Allow-${type}`, `${cors[type]}`)
          }
        }
      }
    }
  }
}
