import type { AnyInjectable, Container, Logger } from '@nmtjs/core'
import type {
  ConnectionIdentity,
  GatewayOptions,
  Transport,
} from '@nmtjs/gateway'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { Lifecycle, TeardownStack } from '@nmtjs/common'
import { ExecutionEnvironmentLifecycleHook } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'

import type { ApplicationResolvedProcedure } from './api/api.ts'
import type {
  AnyApplicationConfig,
  ApplicationConfig,
  ApplicationTransport,
} from './config.ts'
import { kApplicationHostDefinition } from './constants.ts'
import { NeemataApplication } from './runtime.ts'

export type TransportOptionsOf<T> =
  T extends Transport<any, infer Options, any, any, any> ? Options : never

export type ApplicationHostTransportConfig<
  Transports extends Record<string, ApplicationTransport>,
> = {
  [K in keyof Transports]: {
    transport: Transports[K]
    /**
     * Injectable resolved against the initialized application container
     * right before the transport is created — options may depend on
     * application services (config, auth verifiers, secrets). Wrap static
     * options with `createValueInjectable(...)`.
     */
    options: AnyInjectable<TransportOptionsOf<Transports[K]>>
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
    'streamIdleTimeout' | 'heartbeat'
  >
  identity?: ConnectionIdentity
}

export type AnyApplicationHostDefinition = ApplicationHostDefinition<
  AnyApplicationConfig,
  any
>

export type ApplicationHostDefinitionOptions<
  Transports extends Record<string, ApplicationTransport>,
> = {
  transports: Transports
  gateway?: Pick<
    GatewayOptions<ApplicationResolvedProcedure>,
    'streamIdleTimeout' | 'heartbeat'
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
    'streamIdleTimeout' | 'heartbeat'
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
  readonly #lifecycle = new Lifecycle<
    Awaited<ReturnType<Gateway<ApplicationResolvedProcedure>['start']>>
  >('application host')

  constructor(
    protected appConfig: ApplicationConfig,
    protected readonly options: ApplicationHostOptions<Transports>,
  ) {}

  async start() {
    return await this.#lifecycle.start(async (defer) => {
      this.application = await this.createApplication(this.appConfig)
      defer(() => this.application.dispose())

      // Application services acquired by Start hooks unwind after the
      // gateway has stopped accepting (connections drained) but before the
      // application container is disposed.
      const appServices = new TeardownStack()
      defer(async () => {
        const errors = await appServices.unwind()
        if (errors.length) {
          throw new AggregateError(
            errors,
            'Failed to stop application services',
          )
        }
      })

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

      // Gateway.start rolls back its own partially-started transports, so it
      // is deferred only once fully started.
      const hosts = await this.gateway.start()
      defer(() => this.gateway.stop())

      // Stop hooks pair with Start having been attempted; registered before
      // the Start pass so effect teardowns (registered during it) run first.
      appServices.defer(() =>
        this.application.lifecycleHooks.callHook(
          ExecutionEnvironmentLifecycleHook.Stop,
        ),
      )
      await this.runStartHooks(appServices)

      return hosts
    })
  }

  async stop(): Promise<void> {
    await this.#lifecycle.stop()
  }

  /**
   * Runs Start hooks serially; a hook may return a teardown, which unwinds
   * on stop (or on a failed start) only if that hook actually ran — unlike
   * the global Stop hook list, which cannot know which Start hooks completed.
   */
  protected async runStartHooks(appServices: TeardownStack): Promise<void> {
    await this.application.lifecycleHooks.callHookWith(
      async (hooks) => {
        for (const hook of hooks) {
          const teardown = await hook()
          if (typeof teardown === 'function') appServices.defer(teardown)
        }
      },
      ExecutionEnvironmentLifecycleHook.Start,
      [],
    )
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
    await this.gateway.reload({
      api: this.application.api,
      container: this.application.container,
      hooks: this.application.lifecycleHooks,
      identity: this.options.identity,
    })
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
      const options = await this.application.container.resolve(config.options)
      transports[key] = {
        transport: await config.transport.factory(options),
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
