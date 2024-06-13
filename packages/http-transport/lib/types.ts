import type { Pattern } from '@neematajs/application'
import type { AppOptions } from 'uWebSockets.js'
import type { HttpTransportMethod } from './constants'

export type HttpTransportOptions = {
  port?: number
  hostname?: string
  tls?: AppOptions
  maxPayloadLength?: number
  maxStreamChunkLength?: number
  cors?: {
    origin: string | ((req: Request) => true) | Pattern
    methods?: string[]
    headers?: string[]
    credentials?: string
  }
}

export type HttpTransportData = {
  transport: 'http'
  headers: Record<string, string>
  query: URLSearchParams
  ip: string | null
  proxy: string | null
  method: HttpTransportMethod
}
