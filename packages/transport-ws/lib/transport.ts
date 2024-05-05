import { BaseTransport } from '@neematajs-bun/application'
import { WsServer } from './server'
import type { WsTransportOptions } from './types'

export class WsTransport extends BaseTransport<any, WsTransportOptions> {
  name = 'WebSockets'

  server!: WsServer

  initialize() {
    this.server = new WsServer(this)
    this.application.logger.info(
      'Initialized WebSockets transport: %s',
      this.server ? 'OK' : 'FAILED',
    )
  }

  async start() {
    this.application.logger.info(
      'Starting WebSockets server... %s',
      this.server ? 'OK' : 'FAILED',
    )
    await this.server.start()
  }

  async stop() {
    await this.server.stop()
  }
}
