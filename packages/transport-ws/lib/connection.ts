import {
  BaseTransportConnection,
  type Registry,
  type Subscription,
} from '@neematajs-bun/application'
import { MessageType } from './constants'
import type {
  HttpTransportData,
  WsTransportData,
  WsTransportSocket,
} from './types'
import { sendPayload } from './utils'

export class HttpTransportConnection extends BaseTransportConnection {
  readonly transport = 'http'

  constructor(
    protected readonly registry: Registry,
    readonly data: HttpTransportData,
    private readonly headers: Headers,
  ) {
    super(registry)
  }

  protected sendEvent(): boolean {
    throw new Error(
      'HTTP transport does not support bi-directional communication',
    )
  }

  setHeader(key: string, value: string) {
    this.headers.set(key, value)
  }
}

export class WebsocketsTransportConnection extends BaseTransportConnection {
  readonly transport = 'websockets'

  #websocket: WsTransportSocket

  constructor(
    protected readonly registry: Registry,
    readonly data: WsTransportData,
    websocket: WsTransportSocket,
    id: string,
    subscriptions: Map<string, Subscription>,
  ) {
    super(registry, id, subscriptions)
    this.#websocket = websocket
  }

  protected sendEvent(event: string, payload: any) {
    return sendPayload(this.#websocket, MessageType.Event, [event, payload])
  }
}
