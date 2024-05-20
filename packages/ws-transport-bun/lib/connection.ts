import {
  BaseTransportConnection,
  type Registry,
  type Subscription,
} from '@neematajs/application'
import { MessageType } from '@neematajs/common'
import type { WsTransportData, WsTransportSocket } from './types'
import { sendPayload } from './utils'

export class WsConnection extends BaseTransportConnection {
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
