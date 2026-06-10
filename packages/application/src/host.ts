import type { Container, Logger } from '@nmtjs/core'
import type {
  ConnectionIdentity,
  GatewayOptions,
  Transport,
} from '@nmtjs/gateway'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { Gateway } from '@nmtjs/gateway'

import type { ApplicationResolvedProcedure } from './api/api.ts'
import type { ApplicationConfig, ApplicationTransport } from './config.ts'
import { kApplicationHostDefinition } from './constants.ts'
import { LifecycleHook } from './enums.ts'
import { NeemataApplication } from './runtime.ts'

export type TransportOptionsOf<T> =
  T extends Transport<any, infer Options, any, any, any> ? Options : never

export type ApplicationHostTransportConfig<
  Transports extends Record<string, ApplicationTransport>,
> = {
  [K in keyof Transports]: {
    transport: Transports[K]
    options: TransportOptionsOf<Transports[K]>
  }
}

export interface ApplicationHostDefinition<
  App extends ApplicationConfig = ApplicationConfig,
  Transports extends Record<string, ApplicationTransport> = Record<
    string,
    ApplicationTransport
  >,
> {
  [kApplicationHostDefinition]: any
  application: App
  transports: Transports
  gateway?: Pick<
    GatewayOptions<ApplicationResolvedProcedure>,
    'streamTimeouts' | 'heartbeat'
  >
  identity?: ConnectionIdentity
}

export type ApplicationHostDefinitionOptions<
  Transports extends Record<string, ApplicationTransport>,
> = {
  transports: Transports
  gateway?: Pick<
    GatewayOptions<ApplicationResolvedProcedure>,
    'streamTimeouts' | 'heartbeat'
  >
  identity?: ConnectionIdentity
}

export interface ApplicationHostOptions<
  Transports extends Record<string, ApplicationTransport> = Record<
    string,
    ApplicationTransport
  >,
> {
  name?: string
  logger: Logger
  container?: Container
  formats: ProtocolFormats
  transports: ApplicationHostTransportConfig<Transports>
  gateway?: Pick<
    GatewayOptions<ApplicationResolvedProcedure>,
    'streamTimeouts' | 'heartbeat'
  >
  identity?: ConnectionIdentity
}

export class ApplicationHost<
  Transports extends Record<string, ApplicationTransport> = Record<
    string,
    ApplicationTransport
  >,
> {
  application!: NeemataApplication
  gateway!: Gateway<ApplicationResolvedProcedure>
  transports!: GatewayOptions<ApplicationResolvedProcedure>['transports']

  constructor(
    protected appConfig: ApplicationConfig,
    protected readonly options: ApplicationHostOptions<Transports>,
  ) {}

  async start() {
    this.application = await this.createApplication(this.appConfig)
    this.transports = await this.createTransports()
    this.gateway = new Gateway({
      ...this.options.gateway,
      logger: this.options.logger,
      container: this.application.container,
      hooks: this.application.lifecycleHooks,
      formats: this.options.formats,
      transports: this.transports,
      api: this.application.api,
      identity: this.options.identity,
    })

    return await this.gateway.start().finally(async () => {
      await this.application.lifecycleHooks.callHook(LifecycleHook.Start)
    })
  }

  async stop(): Promise<void> {
    await this.gateway.stop()
    await this.application.lifecycleHooks.callHook(LifecycleHook.Stop)
    await this.application.dispose()
  }

  async reload(
    hostDefinition: ApplicationHostDefinition<any, Transports>,
  ): Promise<void> {
    await this.reloadApplication(hostDefinition.application)
  }

  async reloadApplication(appConfig: ApplicationConfig): Promise<void> {
    await this.application.dispose()
    this.appConfig = appConfig
    this.application = await this.createApplication(appConfig)
    this.gateway.options.api = this.application.api
    this.gateway.options.container = this.application.container
    this.gateway.options.hooks = this.application.lifecycleHooks
    this.gateway.options.identity =
      this.options.identity ?? this.gateway.options.identity
    await this.gateway.reload()
  }

  protected async createApplication(appConfig: ApplicationConfig) {
    const application = new NeemataApplication(appConfig, {
      logger: this.options.logger,
      container: this.options.container,
      name: this.options.name,
    })
    await application.initialize()
    return application
  }

  protected async createTransports() {
    const transports: GatewayOptions<ApplicationResolvedProcedure>['transports'] =
      {}

    for (const key in this.options.transports) {
      const config = this.options.transports[key]
      transports[key] = {
        transport: await config.transport.factory(config.options),
        proxyable: config.transport.proxyable,
      }
    }

    return transports
  }
}

export function createApplicationHost<
  Transports extends Record<string, ApplicationTransport>,
>(
  appConfig: ApplicationConfig,
  options: ApplicationHostOptions<Transports>,
): ApplicationHost<Transports> {
  return new ApplicationHost(appConfig, options)
}

export function defineApplicationHost<
  const App extends ApplicationConfig,
  const Transports extends Record<string, ApplicationTransport>,
>(
  application: App,
  options: ApplicationHostDefinitionOptions<Transports>,
): ApplicationHostDefinition<App, Transports> {
  return Object.freeze({
    [kApplicationHostDefinition]: true,
    application,
    ...options,
  })
}

export function isApplicationHostDefinition(
  value: any,
): value is ApplicationHostDefinition {
  return Boolean(value?.[kApplicationHostDefinition])
}
