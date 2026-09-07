import type { ProtocolCodecRegistry } from '@nmtjs/protocol/server'

export type NeemataHttpRequest = Request

export interface NeemataHttpOptions {
  /** Codecs available to this native Neemata HTTP handler. */
  codecs: ProtocolCodecRegistry
}

export interface NeemataHttpHandlerOptions {
  path: `/${string}`
  cors?: HttpHandlerCorsOptions
  /**
   * Inherits the host limit when omitted; lower values add a stricter cap.
   * A value above the host limit is a mount-time error — the host would
   * reject such bodies anyway, so the larger number could never take effect.
   */
  maxRequestBodySize?: number
}

export type HttpHandlerCorsCustomOptions = {
  /** `true` reflects any origin; an array is an explicit allowlist. */
  origin: true | string[]
  allowMethods?: string[]
  allowHeaders?: string[]
  allowCredentials?: string
  maxAge?: string
  exposeHeaders?: string[]
  requestHeaders?: string[]
  requestMethod?: string
}

export type HttpHandlerCorsOptions =
  | true
  | string[]
  | HttpHandlerCorsCustomOptions
  | ((
      origin: string,
      request: NeemataHttpRequest,
    ) => boolean | HttpHandlerCorsCustomOptions)
