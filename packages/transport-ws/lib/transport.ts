import { BaseTransport } from '@neematajs-bun/application'
import { WsServer } from './server'
import type { WsTransportOptions } from './types'

export class WsTransport extends BaseTransport<any, WsTransportOptions> {
  name = 'WebSockets'

  server!: WsServer

  initialize() {
    this.server = new WsServer(this)
  }

  async start() {
    await this.server.start()
  }

  async stop() {
    await this.server.stop()
  }
}
