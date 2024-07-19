import { type BaseClientFormat, StreamDataType } from '@neematajs/common'
import { DownStream } from './stream.ts'
import { EventEmitter, type EventMap } from './utils.ts'

export type ClientTransportConnectOptions = {
  services?: string[]
  auth?: string
}

export type ClientTransportRpcCall = {
  service: string
  procedure: string
  callId: number
  payload: any
  abortSignal: AbortSignal
}

export type ClientTransportRpcResult =
  | {
      success: false
      error: { code: string; message?: string; data?: string }
    }
  | {
      success: true
      value: any
    }

export abstract class ClientTransport<
  T extends EventMap = {},
> extends EventEmitter<
  T & { event: [service: string, event: string, payload: any] }
> {
  abstract type: string

  constructor(protected format: BaseClientFormat) {
    super()
  }

  async reconnect(options?: ClientTransportConnectOptions) {
    await this.disconnect()
    await this.connect(options)
  }

  protected createDownStream(type: StreamDataType, ac: AbortController) {
    const transformers = {
      [StreamDataType.Encoded]: (chunk, controller) =>
        controller.enqueue(this.format.decode(chunk)),
      [StreamDataType.Binary]: (chunk, controller) => controller.enqueue(chunk),
    }
    const transformer = transformers[type]
    return new DownStream(transformer, ac)
  }

  abstract connect(options?: ClientTransportConnectOptions): Promise<void>
  abstract disconnect(): Promise<void>
  abstract rpc(
    params: ClientTransportRpcCall,
  ): Promise<ClientTransportRpcResult>
}
