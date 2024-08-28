import type { BaseClientFormat } from '@nmtjs/common'
import { EventEmitter, type EventMap } from './utils.ts'

export type ClientTransportRpcCall = {
  service: string
  procedure: string
  callId: number
  payload: any
  signal: AbortSignal
}

export type ClientTransportRpcResult =
  | {
      success: false
      error: { code: string; message?: string; data?: any }
    }
  | {
      success: true
      value: any
    }

export abstract class ClientTransport<
  T extends EventMap = EventMap,
> extends EventEmitter<
  T & { event: [service: string, event: string, payload: any] }
> {
  abstract type: string

  client!: {
    readonly services: string[]
    readonly format: BaseClientFormat
    readonly auth?: string
  }

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract rpc(
    params: ClientTransportRpcCall,
  ): Promise<ClientTransportRpcResult>
}
