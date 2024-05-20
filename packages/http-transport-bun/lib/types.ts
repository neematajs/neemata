import type { ServerOptions } from '@neematajs/http-server'
import type { SocketAddress, TLSOptions } from 'bun'
import type { HttpTransportMethod } from './constants'

export type HttpTransportOptions = {
  port?: number
  hostname?: string
  tls?: TLSOptions
  maxPayloadLength?: number
  maxStreamChunkLength?: number
  cors?: ServerOptions['cors']
}

export type HttpTransportProcedureOptions = {
  allowHttp: HttpTransportMethod
}

export type HttpTransportData = {
  transport: 'http'
  headers: Record<string, string>
  query: URLSearchParams
  ip: SocketAddress | null
  method: HttpTransportMethod
}
