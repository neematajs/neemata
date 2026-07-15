import type { MaybePromise, OneOf } from '@nmtjs/common'

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
  /**
   * Maximum request body size in bytes. Requests exceeding it are rejected
   * with 413 Payload Too Large. Defaults to 128MiB (Bun's own default, kept
   * consistent across runtimes).
   */
  maxRequestBodySize?: number
  runtime?: HttpTransportRuntimes[R]
}

export type HttpTransportCorsCustomParams = {
  allowMethods?: string[]
  allowHeaders?: string[]
  maxAge?: string
  exposeHeaders?: string[]
  requestHeaders?: string[]
  requestMethod?: string
} & (
  | {
      /**
       * `true` reflects any request origin, an array is an explicit
       * allowlist. Credentials default on for allowlisted origins only.
       */
      origin: true | string[]
      allowCredentials?: never
    }
  | {
      /**
       * Explicit `allowCredentials` requires an origin allowlist: combining
       * credentials with a reflected origin (`origin: true`) would let any
       * website make credentialed (cookie-authed) requests.
       */
      origin: string[]
      allowCredentials?: string
    }
)

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
  ) => MaybePromise<Response>
  cors?: HttpTransportCorsOptions
  tls?: HttpTransportTlsOptions
  maxRequestBodySize?: number
  runtime?: HttpTransportRuntimes[R]
}

export type DenoServer = ReturnType<typeof globalThis.Deno.serve>

export interface HttpAdapterServer {
  runtime: {
    bun?: import('bun').Server<undefined>
    node?: import('uWebSockets.js').TemplatedApp
    deno?: DenoServer
  }
  stop: () => MaybePromise<any>
  start: () => MaybePromise<string>
}

export type HttpAdapterServerFactory<
  R extends keyof HttpTransportRuntimes = keyof HttpTransportRuntimes,
> = (params: HttpAdapterParams<R>) => HttpAdapterServer
