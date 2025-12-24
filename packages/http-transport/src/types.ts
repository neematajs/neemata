import type { Async, OneOf } from '@nmtjs/common'

export type HttpTransportServerRequest = {
  url: URL
  method: string
  headers: Headers
}

export type HttpTransportOptions<
  R extends keyof HttpTransportRuntimes = keyof HttpTransportRuntimes,
> = {
  listen: HttpTransportListenOptions
  cors?: HttpTransportCorsOptions
  tls?: HttpTransportTlsOptions
  runtime?: HttpTransportRuntimes[R]
}

export type HttpTransportCorsCustomParams = {
  origin: true | string[]
  allowMethods?: string[]
  allowHeaders?: string[]
  allowCredentials?: string
  maxAge?: string
  exposeHeaders?: string[]
  requestHeaders?: string[]
  requestMethod?: string
}

export type HttpTransportCorsOptions =
  | true
  | string[]
  | HttpTransportCorsCustomParams
  | ((
      origin: string,
      request: HttpTransportServerRequest,
    ) => boolean | HttpTransportCorsCustomParams)

export type HttpTransportListenOptions = OneOf<
  [{ port: number; hostname?: string; reusePort?: boolean }, { unix: string }]
>

export type HttpTransportRuntimeBun = Partial<
  Pick<
    import('bun').Serve.Options<undefined>,
    'development' | 'id' | 'maxRequestBodySize' | 'idleTimeout' | 'ipv6Only'
  > &
    import('bun').Serve.Routes<any, any>
>

export type HttpTransportRuntimeNode = {}

export type HttpTransportRuntimeDeno = {}

export type HttpTransportRuntimes = {
  bun: HttpTransportRuntimeBun
  node: HttpTransportRuntimeNode
  deno: HttpTransportRuntimeDeno
}

export type HttpTransportTlsOptions = {
  /**
   * File path or inlined TLS certificate in PEM format (required).
   */
  cert?: string
  /**
   * File path or inlined TLS private key in PEM format (required).
   */
  key?: string
  /**
   * Passphrase for the private key (optional).
   */
  passphrase?: string
}

export type HttpAdapterParams<
  R extends keyof HttpTransportRuntimes = keyof HttpTransportRuntimes,
> = {
  listen: HttpTransportListenOptions
  fetchHandler: (
    request: HttpTransportServerRequest,
    body: ReadableStream | null,
    signal: AbortSignal,
  ) => Async<Response>
  cors?: HttpTransportCorsOptions
  tls?: HttpTransportTlsOptions
  runtime?: HttpTransportRuntimes[R]
}

export type DenoServer = ReturnType<typeof globalThis.Deno.serve>

export interface HttpAdapterServer {
  runtime: {
    bun?: import('bun').Server<undefined>
    node?: import('uWebSockets.js').TemplatedApp
    deno?: DenoServer
  }
  stop: () => Async<any>
  start: () => Async<string>
}

export type HttpAdapterServerFactory<
  R extends keyof HttpTransportRuntimes = keyof HttpTransportRuntimes,
> = (params: HttpAdapterParams<R>) => HttpAdapterServer
