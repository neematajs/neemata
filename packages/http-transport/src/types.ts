import type { MaybePromise, OneOf } from '@nmtjs/common'
import type {
  DenoServer,
  ServerFetchHandler,
  ServerHost,
  ServerListenOptions,
  ServerNativeHandles,
  ServerRequest,
  ServerRuntimeName,
  ServerRuntimeOptions,
  ServerTlsOptions,
} from '@nmtjs/server-host'

export type { DenoServer }

export type HttpTransportServerRequest = ServerRequest

export type HttpTransportListenOptions = ServerListenOptions

export type HttpTransportTlsOptions = ServerTlsOptions

export type HttpTransportRuntimeBun = ServerRuntimeOptions['bun']

export type HttpTransportRuntimeNode = ServerRuntimeOptions['node']

export type HttpTransportRuntimeDeno = ServerRuntimeOptions['deno']

export type HttpTransportRuntimes = ServerRuntimeOptions

/**
 * The transport either owns its socket (`listen` mode) or mounts onto a
 * shared `ServerHost` (`server` mode), so one HTTP server can carry
 * multiple transports (e.g. HTTP and WS on a single listen address).
 */
export type HttpTransportOptions<
  R extends ServerRuntimeName = ServerRuntimeName,
> = {
  cors?: HttpTransportCorsOptions
  /**
   * Maximum request body size in bytes. Requests exceeding it are rejected
   * with 413 Payload Too Large. Defaults to 128MiB (Bun's own default, kept
   * consistent across runtimes).
   */
  maxRequestBodySize?: number
} & OneOf<
  [
    {
      listen: HttpTransportListenOptions
      tls?: HttpTransportTlsOptions
      runtime?: HttpTransportRuntimes[R]
    },
    { server: ServerHost<R> },
  ]
>

export type HttpTransportCorsCustomParams = {
  /**
   * `true` reflects any request origin, an array is an explicit allowlist.
   * Credentials default on only for allowlisted origins.
   */
  origin: true | string[]
  allowMethods?: string[]
  allowHeaders?: string[]
  /**
   * Explicitly enables credentials when reflecting request origins. Only use
   * this when the API should accept credentialed requests from any website.
   */
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

export type HttpAdapterParams<R extends ServerRuntimeName = ServerRuntimeName> =
  HttpTransportOptions<R> & {
    fetchHandler: ServerFetchHandler
  }

export interface HttpAdapterServer {
  runtime: ServerNativeHandles
  stop: () => MaybePromise<any>
  start: () => MaybePromise<string>
}

export type HttpAdapterServerFactory<
  R extends ServerRuntimeName = ServerRuntimeName,
> = (params: HttpAdapterParams<R>) => HttpAdapterServer
