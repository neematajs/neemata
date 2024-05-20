import { BaseTransport } from '@neematajs/application'
import type { WsConnection } from './connection'
import { WsTransportServer } from './server'
import type { WsTransportOptions } from './types'

export class WsTransport extends BaseTransport<
  WsConnection,
  WsTransportOptions
> {
  name = 'WebSockets'

  server!: WsTransportServer

  initialize() {
    this.server = new WsTransportServer(this)
  }

  async start() {
    await this.server.start()
  }

  async stop() {
    await this.server.stop()
  }
}
