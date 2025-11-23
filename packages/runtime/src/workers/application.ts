import assert from 'node:assert'

import type { Dependant } from '@nmtjs/core'
import type { TransportV2, TransportV2Worker } from '@nmtjs/gateway'
import { createFactoryInjectable } from '@nmtjs/core'
import { connectionId, Gateway } from '@nmtjs/gateway'
import { JsonFormat, StandardJsonFormat } from '@nmtjs/json-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

import type { ApplicationConfig } from '../application/config.ts'
import type { ServerConfig } from '../server/config.ts'
import { isApplicationConfig } from '../application/config.ts'
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
  transports!: { [key: string]: TransportV2Worker }

  constructor(
    readonly config: ServerConfig,
    readonly runtimeOptions: ApplicationWorkerRuntimeOptions,
  ) {
    super(config, {
      logger: config.logger,
      name: `Worker ${runtimeOptions.name}`,
    })
  }

  async start() {
    await this.initialize()
    return await this.gateway.start()
  }

  async stop() {
    await this.gateway.stop()
    await this.dispose()
  }

  protected async _initialize(): Promise<void> {
    await super._initialize()

    const module = await import(this.runtimeOptions.path)
    const appConfig = module.default as ApplicationConfig
    assert(
      isApplicationConfig(appConfig),
      `Invalid application config exported from [${this.runtimeOptions.path}]`,
    )
    this.application = new ApplicationRuntime({
      name: `Application ${this.runtimeOptions.name}`,
      container: this.container,
      logger: this.config.logger,
      plugins: appConfig.plugins,
      api: appConfig.api,
      router: appConfig.router,
      filters: appConfig.filters,
      guards: appConfig.guards,
      middlewares: appConfig.middlewares,
      hooks: appConfig.hooks,
    })
    this.application.initialize()

    this.transports = {}

    for (const key in this.runtimeOptions.transports) {
      const options = this.runtimeOptions.transports[key]
      const { factory } = appConfig.transports[key] as TransportV2
      Object.assign(this.transports, { [key]: factory(options) })
    }

    this.gateway = new Gateway({
      logger: this.logger,
      container: this.container,
      hooks: this.hooks,
      api: this.application.api,
      formats: new ProtocolFormats([
        new StandardJsonFormat(),
        new JsonFormat(),
      ]),
      transports: this.transports,
      identityResolver:
        appConfig.identityResolver ??
        createFactoryInjectable({
          dependencies: { connectionId },
          factory: ({ connectionId }) => connectionId,
        }),
    })
  }

  protected async _dispose(): Promise<void> {
    await this.application.dispose()
    await super._dispose()
  }

  protected *_dependents(): Generator<Dependant> {}
}
