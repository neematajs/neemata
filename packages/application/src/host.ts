import type { AnyInjectable, Container, Logger } from '@nmtjs/core'
import type {
  ConnectionIdentity,
  GatewayHost,
  GatewayTransports,
  Transport,
} from '@nmtjs/gateway'
import { Lifecycle, TeardownStack } from '@nmtjs/common'
import { ExecutionEnvironmentLifecycleHook } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'

import type { ApplicationResolvedProcedure } from './api/api.ts'
import type {
  AnyApplicationConfig,
  ApplicationConfig,
  ApplicationTransports,
} from './config.ts'
import { kApplicationHostDefinition } from './constants.ts'
import { NeemataApplication } from './runtime.ts'

export type TransportOptionsOf<T> =
  T extends Transport<infer Options, any, any, any> ? Options : never

export type ApplicationHostTransportConfig<
  Transports extends ApplicationTransports,
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
  Transports extends ApplicationTransports = ApplicationTransports,
> {
  [kApplicationHostDefinition]: true
  application: App
  transports: Transports
  identity?: ConnectionIdentity
}

export type AnyApplicationHostDefinition = ApplicationHostDefinition<
  AnyApplicationConfig,
  any
>

export type ApplicationHostDefinitionOptions<
  Transports extends ApplicationTransports,
> = Pick<ApplicationHostDefinition<any, Transports>, 'transports' | 'identity'>

export interface ApplicationHostOptions<
  Transports extends ApplicationTransports = ApplicationTransports,
> {
  name?: string
  logger: Logger
  container?: Container
  transports: ApplicationHostTransportConfig<Transports>
  identity?: ConnectionIdentity
}

export class ApplicationHost<
  Transports extends ApplicationTransports = ApplicationTransports,
> {
  application!: NeemataApplication
  gateway!: Gateway<ApplicationResolvedProcedure>
  transports!: GatewayTransports<ApplicationResolvedProcedure>
  readonly #lifecycle = new Lifecycle<GatewayHost[]>('application host')

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
        logger: this.options.logger,
        container: this.application.container,
        hooks: this.application.lifecycleHooks,
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
    const transports: GatewayTransports<ApplicationResolvedProcedure> = {}

    for (const [key, config] of Object.entries(this.options.transports)) {
      const options = await this.application.container.resolve(config.options)
      const transport = await config.transport.factory(options)
      transports[key] = {
        transport,
        proxyable: config.transport.proxyable,
      }
    }

    return transports
  }
}

export function createApplicationHost<Transports extends ApplicationTransports>(
  appConfig: ApplicationConfig,
  options: ApplicationHostOptions<Transports>,
): ApplicationHost<Transports> {
  return new ApplicationHost(appConfig, options)
}

export function defineApplicationHost<
  const App extends ApplicationConfig,
  const Transports extends ApplicationTransports,
>(
  application: App,
  options: ApplicationHostDefinitionOptions<Transports>,
): ApplicationHostDefinition<App, Transports> {
  return Object.freeze({
    [kApplicationHostDefinition]: true,
    application,
    ...options,
  } satisfies ApplicationHostDefinition<App, Transports>)
}

export function isApplicationHostDefinition(
  value: any,
): value is ApplicationHostDefinition {
  return Boolean(value?.[kApplicationHostDefinition])
}
