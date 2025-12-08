import type { Dependant } from '@nmtjs/core'
import type { GatewayOptions, Transport } from '@nmtjs/gateway'
import { Gateway } from '@nmtjs/gateway'
import { JsonFormat } from '@nmtjs/json-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

import type { ApplicationConfig } from '../application/config.ts'
import type { ServerConfig } from '../server/config.ts'
import { ApplicationRuntime } from '../application/runtime.ts'
import { BaseWorkerRuntime } from './base.ts'

export interface ApplicationWorkerRuntimeOptions {
  name: string
  path: string
  transports: { [key: string]: any }
}

export class ApplicationWorkerRuntime extends BaseWorkerRuntime {
  application!: ApplicationRuntime
  gateway!: Gateway
  transports!: GatewayOptions['transports']

  constructor(
    readonly config: ServerConfig,
    readonly runtimeOptions: ApplicationWorkerRuntimeOptions,
    protected appConfig: ApplicationConfig,
  ) {
    super(config, {
      logger: config.logger,
      name: `Worker ${runtimeOptions.name}`,
    })
  }

  async start() {
    await this.initialize()

    this.transports = {}

    for (const key in this.runtimeOptions.transports) {
      const options = this.runtimeOptions.transports[key]
      const { factory, proxyable } = this.appConfig.transports[key] as Transport
      this.transports[key] = { transport: await factory(options), proxyable }
    }

    this.gateway = new Gateway({
      logger: this.logger,
      container: this.container,
      hooks: this.hooks,
      formats: new ProtocolFormats([new JsonFormat()]),
      transports: this.transports,
      api: this.application.api,
      identity: this.appConfig.identity,
    })

    return await this.gateway.start()
  }

  async stop() {
    await this.gateway.stop()
    await this.dispose()
  }

  async reload(appConfig: ApplicationConfig): Promise<void> {
    await this.dispose()
    this.appConfig = appConfig
    await this.initialize()
    this.gateway.options.api = this.application.api
    this.gateway.options.identity =
      this.appConfig.identity ?? this.gateway.options.identity
    await this.gateway.reload()
  }

  protected async _initialize(): Promise<void> {
    await super._initialize()
    this.application = new ApplicationRuntime({
      name: `Application ${this.runtimeOptions.name}`,
      container: this.container,
      logger: this.config.logger,
      plugins: this.appConfig.plugins,
      api: this.appConfig.api,
      router: this.appConfig.router,
      filters: this.appConfig.filters,
      guards: this.appConfig.guards,
      middlewares: this.appConfig.middlewares,
      hooks: this.appConfig.hooks,
    })
    await this.application.initialize()
  }

  protected async _dispose(): Promise<void> {
    await this.application.dispose()
    await super._dispose()
  }

  protected *_dependents(): Generator<Dependant> {}
}
