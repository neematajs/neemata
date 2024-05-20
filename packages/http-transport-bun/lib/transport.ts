import { BaseTransport } from '@neematajs/application'
import type { HttpConnection } from './connection'
import { HttpTransportServer } from './server'
import type { HttpTransportOptions } from './types'

export class HttpTransport extends BaseTransport<
  HttpConnection,
  HttpTransportOptions
> {
  name = 'Http'

  server!: HttpTransportServer

  initialize() {
    this.server = new HttpTransportServer(this)
  }

  async start() {
    await this.server.start()
  }

  async stop() {
    await this.server.stop()
  }
}
